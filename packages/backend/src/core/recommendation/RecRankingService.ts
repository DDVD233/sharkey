/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { MiMeta, MiNote, MiUser } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { analyzeNoteText, lengthReward, LEN_FLOOR } from '@/misc/note-quality.js';
import type { RecFactorKey } from '@/core/rec-settings.js';
import { FACTOR_TO_FEATURE, RANKER_ENGAGEMENTS, blendWeights, mergeEngagementValues, parseRankerModel, scoreWithModel, type RankerEngagementKey, type RankerFeatureKey } from '@/core/rec-ranker.js';
import type Logger from '@/logger.js';
import { RecInterestService } from './RecInterestService.js';
import { RecNoteFeaturesService } from './RecNoteFeaturesService.js';
import { RecRetrievalService } from './RecRetrievalService.js';
import { RECENCY_OFFSET_HOURS, RECENCY_GRAVITY, TAG_SOFT_MAX, TAG_PENALTY_RANGE, AUTHOR_DIVERSITY_PENALTY, LIGHT_RANK_KEEP, ADDITIVE_FACTORS, W_NOTE, NEUTRAL_SIM, QP_QUALITY, HAND_FACTOR_WEIGHTS, type AdditiveFactor } from './constants.js';
import { normalizeLang } from './lang.js';
import { cosine } from './math.js';
import type { NoteFeatures, CandidateFeatures, ScoredCandidate, RecommendationBreakdownRow, RecommendationEngagementRow, RecommendationBreakdown } from './types.js';

@Injectable()
export class RecRankingService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,
		private idService: IdService,
		private recRetrievalService: RecRetrievalService,
		private recNoteFeaturesService: RecNoteFeaturesService,
		private recInterestService: RecInterestService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Two-stage ranking (Twitter-style light → heavy), then an author-diversity re-rank.
	 *
	 * STAGE 1 — light ranker: a cheap per-note score (relevance + quality, freshness-decayed) over signals
	 * already in hand, used only to TRIM the candidate set to the top {@link LIGHT_RANK_KEEP} before the
	 * expensive stage-2 work (author-centroid reads + model evaluation).
	 *
	 * STAGE 2 — heavy ranker: an ADDITIVE score `Σ_factor weight_factor · rawSignal_factor · userCoeff_factor`
	 * × recencyDecay. The per-factor weights are the hand-tuned weights blended with the LEARNED model's
	 * weights by the admin blend λ (`recommendationRankerWeight`; see {@link blendWeights}) — so λ=0 (the
	 * default until ramped / before any model is trained) reproduces the legacy order exactly, and λ=1 uses
	 * the learned coefficients. The user's 0..2 factor coefficient always scales each factor's CONTRIBUTION
	 * (weight·raw·coeff), so user control over a factor is identical whether its weight is hand-tuned or
	 * learned. The model's optional per-engagement logistic heads are evaluated for the DISPLAY-ONLY
	 * "predicted engagement" panel and never affect ranking.
	 *
	 * The full breakdown is stashed on each candidate's `feat` for impression logging + the
	 * "why recommended?" view. A per-author cap then keeps the top of the feed diverse.
	 */
	@bindThis
	public async rankCandidates(userId: MiUser['id'], candidates: ScoredCandidate[], langWeights: Map<string, number>, followedSet: Set<string>, nullLangWeight: number, excludeSensitive: boolean, factors: Record<RecFactorKey, number>, alpha: number, mmIds: Set<string>, features: Map<string, NoteFeatures>, interest: { mm: number[] | null; txt: number[] | null }, cfScores: Map<string, number>, topics: Map<string, string>, topicInterest: Record<string, number>, followSet: Set<string> = new Set(), followSims: Map<string, number> = new Map()): Promise<ScoredCandidate[]> {
		if (candidates.length === 0) return [];
		const __rt0 = Date.now();
		const byId = new Map(candidates.map(c => [c.noteId, c]));
		const notes = await this.recRetrievalService.loadAndFilterNotes([...byId.keys()], userId, excludeSensitive);
		this.logger.info(`[timing] rank loadAndFilterNotes(in=${byId.size} out=${notes.length}): ${Date.now() - __rt0}ms`);

		const now = Date.now();
		// --- STAGE 1: LIGHT RANKER -------------------------------------------------------------------
		// Cheap score over already-available signals (no author-centroid reads, no model eval). Also applies
		// the language filter (notes outside the user's languages are dropped here). Keep the top slice.
		type Lite = { note: MiNote; cand: ScoredCandidate; isMm: boolean; noteSim: number; quality: number; recencyMult: number; langW: number; fromFollows: boolean; light: number };
		const lite: Lite[] = [];
		for (const note of notes) {
			const cand = byId.get(note.id);
			if (cand == null) continue;
			const fromFollows = followSet.has(note.id);
			const norm = normalizeLang(note.lang);
			// Follows are shown regardless of the rec language filter (you chose to follow them) — langW 1.
			const langW = fromFollows ? 1 : (norm != null ? (langWeights.get(norm) ?? 0) : nullLangWeight);
			if (langW <= 0) continue;
			const isMm = mmIds.has(note.id);
			// ANN-retrieved candidates carry a real user↔note cosine; follows get one computed from their
			// stored vector (followSims); anything else (CF/fallback) had none, so use the neutral default.
			const followSim = fromFollows ? followSims.get(note.id) : undefined;
			const noteSim = cand.source === 'ann'
				? Math.max(0, Math.min(1, cand.annScore))
				: (followSim != null ? Math.max(0, Math.min(1, followSim)) : NEUTRAL_SIM);
			const quality = this.recNoteFeaturesService.qualityOf(features.get(note.id));
			const ageHours = (now - this.idService.parse(note.id).date.getTime()) / (1000 * 60 * 60);
			const recencyMult = Math.pow(RECENCY_OFFSET_HOURS / (ageHours + RECENCY_OFFSET_HOURS), RECENCY_GRAVITY);
			const light = (W_NOTE * noteSim + QP_QUALITY * quality) * recencyMult;
			lite.push({ note, cand, isMm, noteSim, quality, recencyMult, langW, fromFollows, light });
		}
		lite.sort((a, b) => b.light - a.light);
		const kept = lite.slice(0, LIGHT_RANK_KEEP);
		this.logger.info(`[timing] rank light-ranker(${notes.length}→${kept.length}): ${Date.now() - __rt0}ms`);

		// Author produce-centroids for the SURVIVING candidates' authors only (Tier A), per modality. Read
		// in one pipelined batch each; the user↔author cosine is the author-similarity prior. Skipped when
		// there's no user vector for that modality.
		const authorIds = kept.map(k => k.note.userId);
		const [authorCentroidsMm, authorCentroidsTxt] = await Promise.all([
			interest.mm ? this.recInterestService.getAuthorCentroids(authorIds, 'mm') : Promise.resolve(new Map<string, number[]>()),
			interest.txt ? this.recInterestService.getAuthorCentroids(authorIds, 'txt') : Promise.resolve(new Map<string, number[]>()),
		]);

		// Learned ranker model + admin config, read from the live `meta` reference. A null/malformed model
		// (or λ=0) means pure hand-tuned weights — identical to the pre-learned-ranker behaviour.
		const model = parseRankerModel(this.meta.recommendationRankerModel);
		const lambda = model != null ? Math.max(0, Math.min(1, this.meta.recommendationRankerWeight)) : 0;
		const values = mergeEngagementValues(this.meta.recommendationEngagementValues as Partial<Record<RankerEngagementKey, number>> | null);
		// Effective per-factor weights, computed ONCE for the whole build: the hand-tuned signed weights
		// blended with the learned model's per-feature weights by λ (the learned weight for a factor is
		// looked up via FACTOR_TO_FEATURE). At λ=0 / no model this is exactly HAND_FACTOR_WEIGHTS.
		const learnedFactorW: Partial<Record<AdditiveFactor, number>> = {};
		if (model?.weights != null) {
			for (const factor of ADDITIVE_FACTORS) learnedFactorW[factor] = model.weights[FACTOR_TO_FEATURE[factor]] ?? 0;
		}
		const ew = blendWeights(HAND_FACTOR_WEIGHTS, learnedFactorW, lambda) as Record<AdditiveFactor, number>;
		const __rt1 = Date.now();

		// --- STAGE 2: HEAVY RANKER -------------------------------------------------------------------
		const f = factors;
		const scored: { cand: ScoredCandidate; authorId: string; score: number }[] = [];
		for (const k of kept) {
			const { note, cand, isMm, noteSim, quality, recencyMult, langW, fromFollows } = k;

			// Author-similarity prior (Tier A): user↔author-centroid cosine in this note's modality. Falls
			// back to the note-sim when the user has no vector for this modality or the author has too few
			// posts for a trustworthy centroid — so the composite never penalizes cold authors.
			const userVec = isMm ? interest.mm : interest.txt;
			const authorCentroid = (isMm ? authorCentroidsMm : authorCentroidsTxt).get(note.userId);
			const authorSim = (userVec != null && authorCentroid != null)
				? Math.max(0, Math.min(1, cosine(userVec, authorCentroid)))
				: noteSim;

			const feat = features.get(note.id);
			const engagementRaw = this.engagementOf(note);
			const engagement = Math.min(1, Math.log1p(engagementRaw) / Math.log1p(1000)); // soft-normalize

			// Recency: the raw power-law decay ∈ (0,1] is both a multiplicative gate on the hand score and a
			// feature for the learned heads. The personal coefficient is applied to the hand gate as a
			// deviation from 1 (coef 0 → ×1 / recency ignored, 1 → full decay, 2 → exaggerated; clamped ≥0).
			const effRecency = Math.max(0, 1 - (1 - recencyMult) * f.recency);

			// Structural penalty signals ∈ [0,1].
			const readableLength = feat?.readableLength ?? analyzeNoteText(note.text).readableLength;
			const lenNorm = Math.max(0, Math.min(1, (lengthReward(readableLength) - LEN_FLOOR) / (1 - LEN_FLOOR)));
			const shortness = isMm ? 0 : (1 - lenNorm);
			const hashtagCount = note.tags.length;
			const overTag = hashtagCount <= TAG_SOFT_MAX ? 0 : Math.min(1, (hashtagCount - TAG_SOFT_MAX) / TAG_PENALTY_RANGE);
			const isSelfReply = note.replyId != null && note.reply != null && note.reply.userId === note.userId;
			const isReply = (note.replyId != null && !isSelfReply) ? 1 : 0;

			const topic = topics.get(note.id) ?? null;
			const topicV = topic != null ? (topicInterest[topic] ?? 0) : 0;
			const cfHit = cfScores.has(note.id);
			const followed = followedSet.has(note.userId);

			// ADDITIVE score with the effective (hand↔learned-blended) per-factor weights. Each factor's raw
			// signal is fed as its POSITIVE magnitude (the weight carries the sign), scaled by the user's
			// per-factor coefficient — so the user always amplifies/reduces/removes a factor's CONTRIBUTION,
			// whether the weight is hand-tuned or learned. Then the multiplicative recency gate.
			const rawByFactor: Record<AdditiveFactor, number> = {
				relevancy: noteSim,
				authorAffinity: authorSim,
				quality,
				popularity: engagement,
				shortPostPenalty: shortness,
				overTagPenalty: overTag,
				replyPenalty: isReply,
				topicPreference: topicV,
				followed: followed ? 1 : 0,
				similarUsers: cfHit ? 1 : 0,
			};
			let additive = 0;
			for (const factor of ADDITIVE_FACTORS) additive += ew[factor] * rawByFactor[factor] * f[factor];
			const score = additive * effRecency;

			// Per-engagement predicted probabilities (DISPLAY ONLY — the "predicted engagement" insight
			// panel). Evaluated on the RAW features (no user-coeff distortion); never drives ranking.
			let learnedScore: number | undefined;
			let probs: Partial<Record<RankerEngagementKey, number>> | undefined;
			if (model?.heads != null) {
				const x: Partial<Record<RankerFeatureKey, number>> = {
					relevancy: noteSim, authorAffinity: authorSim, quality, popularity: engagement,
					recency: recencyMult, shortness, overTag, isReply, topic: topicV,
					followed: followed ? 1 : 0, cfHit: cfHit ? 1 : 0, mm: isMm ? 1 : 0, langW,
				};
				const r = scoreWithModel(model, x, values);
				learnedScore = r.score;
				probs = r.probs;
			}

			// A note with no net positive signal is never worth recommending.
			if (score <= 0) continue;

			cand.feat = { ann: noteSim, authorSim, cfScore: cfScores.get(note.id) ?? 0, quality, engagement, recency: recencyMult, shortness, overTag, isReply, topicV, topic, langW, alpha, score, followed, cfHit, mm: isMm, coeffs: factors, weights: ew, fromFollows, learnedScore, probs, rankerWeight: lambda };
			scored.push({ cand, authorId: note.userId, score });
		}

		this.logger.info(`[timing] rank heavy-ranker(${kept.length} notes, λ=${lambda}, model=${model != null}): ${Date.now() - __rt1}ms`);

		// Author-diversity re-rank (penalty on the SCORE, not a forced reorder): greedily emit the best note,
		// then each author's k-th emitted note has k·AUTHOR_DIVERSITY_PENALTY subtracted from its effective
		// score, so one prolific author can't clump at the top. The stored per-note score is unchanged (the
		// breakdown shows the true intrinsic score; the penalty only affects ordering).
		const authorCount = new Map<string, number>();
		const pool = scored.map((s) => ({ cand: s.cand, authorId: s.authorId, order: s.score }));
		const out: ScoredCandidate[] = [];
		while (pool.length > 0) {
			let bestIdx = 0;
			let bestAdj = -Infinity;
			for (let i = 0; i < pool.length; i++) {
				const adj = pool[i].order - AUTHOR_DIVERSITY_PENALTY * (authorCount.get(pool[i].authorId) ?? 0);
				if (adj > bestAdj) { bestAdj = adj; bestIdx = i; }
			}
			const picked = pool.splice(bestIdx, 1)[0];
			authorCount.set(picked.authorId, (authorCount.get(picked.authorId) ?? 0) + 1);
			out.push(picked.cand);
		}
		return out;
	}

	@bindThis
	private engagementOf(note: Pick<MiNote, 'reactions' | 'renoteCount' | 'repliesCount'>): number {
		let reactions = 0;
		for (const v of Object.values(note.reactions)) reactions += v;
		return reactions + note.renoteCount + note.repliesCount;
	}

	/**
	 * Reconstructs the per-factor "why was this recommended?" table from a stored score breakdown, using
	 * the same global constants that produced the score and the user's rank-time coefficients (`coeffs`).
	 * Each row reports the raw signal, the global weight, the user's coefficient and the resulting effect
	 * (an additive contribution for blended/bonus factors, or a multiplier for gates).
	 */
	@bindThis
	public buildBreakdown(f: CandidateFeatures): RecommendationBreakdown {
		const c = f.coeffs ?? ({} as Partial<Record<RecFactorKey, number>>);
		// The effective per-factor weights used at rank time (hand-tuned blended with the learned model) —
		// so the "base factor" column reflects the up-to-date LEARNED coefficient. Older queue entries with
		// no stored weights fall back to the hand-tuned defaults.
		const w = f.weights ?? HAND_FACTOR_WEIGHTS;
		// Additive factors: contribution = raw · weight · coeff. Raw is the POSITIVE signal magnitude; the
		// weight carries the sign (penalties have negative weights), so the user coeff scales the signed
		// contribution directly.
		const addRow = (key: AdditiveFactor, raw: number): RecommendationBreakdownRow => {
			const coeff = c[key] ?? 1;
			const weight = w[key];
			return { key, kind: 'add', raw, weight, coeff, effect: raw * weight * coeff };
		};
		const addRows: RecommendationBreakdownRow[] = [
			addRow('relevancy', f.ann),
			addRow('authorAffinity', f.authorSim),
			addRow('quality', f.quality),
			addRow('popularity', f.engagement ?? 0),
			addRow('shortPostPenalty', f.shortness ?? 0),
			addRow('overTagPenalty', f.overTag ?? 0),
			addRow('replyPenalty', f.isReply ?? 0),
			addRow('topicPreference', f.topicV ?? 0),
			addRow('followed', f.followed ? 1 : 0),
			addRow('similarUsers', f.cfHit ? 1 : 0),
		];
		// The additive rows sum to the content subtotal; recency then MULTIPLIES it. The recency row reports
		// the global decay (`raw`), the user's coefficient, and the applied multiplier (`effect`).
		const subtotal = addRows.reduce((s, r) => s + r.effect, 0);
		const recCoeff = c.recency ?? 1;
		const recMult = f.recency; // global power-law decay ∈ (0,1]
		const recencyRow: RecommendationBreakdownRow = {
			key: 'recency', kind: 'mult', raw: recMult, weight: 1, coeff: recCoeff,
			effect: Math.max(0, 1 - (1 - recMult) * recCoeff),
		};
		// Keep the settings-page order: …, popularity, recency, shortPostPenalty, …
		const rows = [...addRows.slice(0, 4), recencyRow, ...addRows.slice(4)];

		// `mode`/`rankerWeight` (λ) report how much the LEARNED weights replaced the hand-tuned ones in the
		// factor table above. The per-engagement panel below is a separate DISPLAY-ONLY insight (the model's
		// logistic heads predicting P(engagement)); it does not affect the score.
		const lambda = f.rankerWeight ?? 0;
		const mode: RecommendationBreakdown['mode'] = lambda <= 0 ? 'hand' : (lambda >= 1 ? 'learned' : 'blend');
		const hasLearned = f.probs != null;
		let engagements: RecommendationEngagementRow[] | undefined;
		if (hasLearned) {
			const values = mergeEngagementValues(this.meta.recommendationEngagementValues as Partial<Record<RankerEngagementKey, number>> | null);
			engagements = [];
			for (const e of RANKER_ENGAGEMENTS) {
				const prob = f.probs?.[e];
				if (prob == null) continue;
				const value = values[e];
				engagements.push({ key: e, prob, value, effect: prob * value });
			}
		}
		return { type: f.fromFollows ? 'following' : 'score', score: f.score, topic: f.topic ?? null, subtotal, rows, mode, learnedScore: f.learnedScore, rankerWeight: f.rankerWeight, engagements };
	}
}
