/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, MiUser, NotesRepository, NoteRecommendationImpressionsRepository, NoteTopicsRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService, type Modality } from '@/core/MilvusService.js';
import { QueueService } from '@/core/QueueService.js';
import { TOPIC_DOWNRANK_DEFAULT, TOPIC_LABELS, type Topic } from '@/core/rec-topics.js';
import { mergeRecSettings, type RecommendationSettings } from '@/core/rec-settings.js';
import type Logger from '@/logger.js';
import { REPLY_WEIGHT, RENOTE_WEIGHT, FAVORITE_WEIGHT, POST_WEIGHT, REACTION_RARE_WEIGHT, REACTION_NORMAL_WEIGHT, REPLY_ENGAGED_NUDGE_WEIGHT, ENGAGED_MAX, AVGVEC_SAMPLE_MAX, AVGVEC_TTL_SEC, PUSHED_TTL_SEC, SOFT_NEGATIVE_WEIGHT, NEG_SAMPLE_MAX, STRONG_NEGATIVE_WEIGHT, DISLIKE_SAMPLE_MAX, DISLIKE_EMA_WEIGHT, INTEREST_WINDOW, EMA_ALPHA, TOPIC_TOP_N, AUTHOR_CENTROID_EMA_ALPHA, AUTHOR_HISTORY_CAP, AUTHOR_CENTROID_MIN_NOTES, type EngagementKind } from './constants.js';
import { normalizeLang } from './lang.js';
import { unit } from './math.js';

@Injectable()
export class RecInterestService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		@Inject(DI.noteRecommendationImpressionsRepository)
		private noteRecommendationImpressionsRepository: NoteRecommendationImpressionsRepository,
		@Inject(DI.noteTopicsRepository)
		private noteTopicsRepository: NoteTopicsRepository,
		private cacheService: CacheService,
		private idService: IdService,
		private milvusService: MilvusService,
		private queueService: QueueService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Records a positive engagement so it feeds the user's interest vector. The numeric signal
	 * weight is computed from the kind (and, for reactions, whether it's a rare/custom emoji) and
	 * stored alongside the note id; the interest vector is marked dirty for lazy recompute.
	 */
	@bindThis
	public async onPositiveEngagement(userId: MiUser['id'], note: Pick<MiNote, 'id' | 'lang'>, kind: EngagementKind, opts?: { reaction?: string }): Promise<void> {
		// The base signal weight (by kind) is scaled by the user's per-kind engagement coefficient, so a
		// user can tune how much each interaction type moves their interest vector (0 = ignore that signal).
		const settings = await this.getEffectiveRecSettings(userId);
		const weight = this.signalWeight(kind, opts?.reaction) * this.engagementCoeff(settings, kind);
		const lang = normalizeLang(note.lang);
		try {
			const key = `rec:engaged:${userId}`;
			const tx = this.redisForTimelines.multi()
				.lpush(key, `${weight}:${note.id}`)
				.ltrim(key, 0, ENGAGED_MAX - 1)
				.expire(key, PUSHED_TTL_SEC)
				.set(`rec:dirty:${userId}`, '1')
				// Track users with engagement so the daily prebuild knows whose vectors to refresh.
				.sadd('rec:users', userId);
			// Learn the user's language affinity from what they actually like (drives the soft filter).
			if (lang != null) {
				tx.hincrbyfloat(`rec:langaff:${userId}`, lang, weight);
				tx.expire(`rec:langaff:${userId}`, PUSHED_TTL_SEC);
			}
			await tx.exec();
			// A local user engaged with this note, so ALWAYS embed it (and keep it embedded) even if it'd
			// normally be filtered out as low-quality — their engagement should always feed their interest
			// vector. `rec:keep:{noteId}` protects it from the score job's quality eviction; the embed job is
			// forced so it doesn't skip a below-retrieval-quality note.
			this.redisForTimelines.set(`rec:keep:${note.id}`, '1', 'EX', PUSHED_TTL_SEC).catch(() => { /* best-effort */ });
			this.queueService.createEmbedNoteJob(note.id, true).catch(() => { /* best-effort */ });
			this.queueService.createScoreNoteJob(note.id).catch(() => { /* best-effort */ });
			// Real-time EMA update of the interest vector. If the note isn't embedded yet, this is a
			// no-op and the periodic full rebuild folds it in once the embed job lands.
			await this.applyEmaUpdate(userId, note.id, weight);
		} catch (err) {
			this.logger.warn(`onPositiveEngagement failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Nudges the user's stored interest vector toward a single liked note (EMA). The note's modality
	 * (multimodal vs text-only) is read from which Milvus collection holds it, and only that modality's
	 * user vector is moved — the two are never blended. Runs off the request path (fire-and-forget).
	 */
	@bindThis
	private async applyEmaUpdate(userId: MiUser['id'], noteId: string, signalWeight: number): Promise<void> {
		// Determine modality by collection membership.
		let modality: Modality | null = null;
		let nv: number[] | undefined;
		const mm = await this.milvusService.getNoteVectors([noteId], 'mm');
		if (mm.has(noteId)) { modality = 'mm'; nv = mm.get(noteId); } else {
			const txt = await this.milvusService.getNoteVectors([noteId], 'txt');
			if (txt.has(noteId)) { modality = 'txt'; nv = txt.get(noteId); }
		}
		if (modality == null || nv == null) return; // not embedded yet — the rebuild will fold it in

		const key = `rec:uvec:${modality}:${userId}`;
		const cachedRaw = await this.redisForTimelines.get(key);
		let cur: number[] | null = null;
		if (cachedRaw != null) {
			try { cur = JSON.parse(cachedRaw) as number[]; } catch { cur = null; }
		}

		const alpha = Math.min(0.5, EMA_ALPHA * signalWeight);
		const vec = nv; // narrowed to number[] above; a const keeps that narrowing inside the closure
		const next = (cur != null && cur.length === vec.length)
			? cur.map((x, i) => (1 - alpha) * x + alpha * vec[i])
			: vec.slice();

		const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return;

		await this.redisForTimelines.multi()
			.set(key, JSON.stringify(next.map(x => x / norm)), 'EX', PUSHED_TTL_SEC)
			.hincrby(`rec:modality:${userId}`, modality, 1)
			.expire(`rec:modality:${userId}`, PUSHED_TTL_SEC)
			.exec();
	}

	/**
	 * Pushes the user's stored interest vector AWAY from a note (Rocchio negative) — used for an explicit
	 * "not interested". Subtracts a fraction of the note vector from the current interest vector and
	 * renormalizes. No-op if the user has no vector for that modality yet (the rebuild folds the dislike
	 * in via rec:disliked instead).
	 */
	@bindThis
	private async applyNegativeEmaUpdate(userId: MiUser['id'], noteId: string, signalWeight: number): Promise<void> {
		let modality: Modality | null = null;
		let nv: number[] | undefined;
		const mm = await this.milvusService.getNoteVectors([noteId], 'mm');
		if (mm.has(noteId)) { modality = 'mm'; nv = mm.get(noteId); } else {
			const txt = await this.milvusService.getNoteVectors([noteId], 'txt');
			if (txt.has(noteId)) { modality = 'txt'; nv = txt.get(noteId); }
		}
		if (modality == null || nv == null) return;

		const key = `rec:uvec:${modality}:${userId}`;
		const cachedRaw = await this.redisForTimelines.get(key);
		if (cachedRaw == null) return;
		let cur: number[] | null = null;
		try { cur = JSON.parse(cachedRaw) as number[]; } catch { cur = null; }
		if (cur == null || cur.length !== nv.length) return;

		const beta = Math.min(0.5, EMA_ALPHA * signalWeight);
		const vec = nv; // narrowed to number[] above; a const keeps that narrowing inside the closure
		const next = cur.map((x, i) => x - beta * vec[i]);
		const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return;

		await this.redisForTimelines.set(key, JSON.stringify(next.map(x => x / norm)), 'EX', PUSHED_TTL_SEC);
	}

	/**
	 * Records an explicit "not interested" on a recommended note: (1) immediately pushes the user's
	 * interest vector away from it, (2) records it as a STRONG negative (rec:disliked) for the next vector
	 * rebuild and for future ranker training, and (3) excludes it from the feed so it's never re-served.
	 */
	@bindThis
	public async markNotInterested(userId: MiUser['id'], noteId: string): Promise<void> {
		try {
			const now = Date.now();
			await this.redisForTimelines.multi()
				.zadd(`rec:pushed:${userId}`, now, noteId) // never re-serve
				.expire(`rec:pushed:${userId}`, PUSHED_TTL_SEC)
				.zadd(`rec:disliked:${userId}`, now, noteId) // strong negative (rebuild + training label)
				.zremrangebyscore(`rec:disliked:${userId}`, '-inf', now - PUSHED_TTL_SEC * 1000)
				.expire(`rec:disliked:${userId}`, PUSHED_TTL_SEC)
				.set(`rec:dirty:${userId}`, '1') // fold the dislike into the next interest-vector rebuild
				.exec();
			await this.applyNegativeEmaUpdate(userId, noteId, DISLIKE_EMA_WEIGHT);
		} catch (err) {
			this.logger.warn(`markNotInterested failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Records "reply engaged by author": the viewer replied to a recommended note AND the note's author
	 * engaged that reply back (reacted to it or replied to it). This is the single highest-value positive
	 * outcome in Twitter's heavy ranker (weight 75) — a strong signal the recommendation landed. We (1)
	 * store it as a training label (`rec:replyengaged:{viewerId}`, the recommended note's id), and (2) give
	 * the viewer's interest vector an extra nudge toward that note. Detected in ReactionService /
	 * NoteCreateService when the engager is the author of the note being replied to. Best-effort.
	 */
	@bindThis
	public async onReplyEngagedByAuthor(viewerId: MiUser['id'], recommendedNoteId: string): Promise<void> {
		try {
			const now = Date.now();
			const key = `rec:replyengaged:${viewerId}`;
			await this.redisForTimelines.multi()
				.zadd(key, now, recommendedNoteId)
				.zremrangebyscore(key, '-inf', now - PUSHED_TTL_SEC * 1000)
				.expire(key, PUSHED_TTL_SEC)
				.exec();
			await this.applyEmaUpdate(viewerId, recommendedNoteId, REPLY_ENGAGED_NUDGE_WEIGHT);
		} catch (err) {
			this.logger.warn(`onReplyEngagedByAuthor failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Folds client-reported dwell times into the impression log: for each (note, dwellMs) the most recent
	 * impression row of this user for that note (within the last hour) gets its `dwellMs` set to the larger
	 * of the existing and reported value. This is the "good click" training signal for the learned ranker.
	 * Best-effort; capped by the endpoint's paramDef (≤50 items).
	 */
	@bindThis
	public async recordDwell(userId: MiUser['id'], items: { noteId: string; dwellMs: number }[]): Promise<void> {
		if (items.length === 0) return;
		// Collapse duplicate note ids to the max reported dwell.
		const byNote = new Map<string, number>();
		for (const it of items) {
			if (!Number.isFinite(it.dwellMs) || it.dwellMs < 0) continue;
			byNote.set(it.noteId, Math.max(byNote.get(it.noteId) ?? 0, Math.round(it.dwellMs)));
		}
		if (byNote.size === 0) return;
		const sinceId = this.idService.gen(Date.now() - 60 * 60 * 1000); // only recent impressions
		for (const [noteId, dwellMs] of byNote) {
			try {
				await this.noteRecommendationImpressionsRepository.createQueryBuilder()
					.update()
					.set({ dwellMs: () => `GREATEST(COALESCE("dwellMs", 0), ${dwellMs})` })
					.where('id = (SELECT i.id FROM note_recommendation_impression i WHERE i."userId" = :userId AND i."noteId" = :noteId AND i.id > :sinceId ORDER BY i.id DESC LIMIT 1)', { userId, noteId, sinceId })
					.execute();
			} catch (err) {
				this.logger.warn(`recordDwell failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	@bindThis
	private signalWeight(kind: EngagementKind, reaction?: string): number {
		switch (kind) {
			case 'reply': return REPLY_WEIGHT;
			case 'renote': return RENOTE_WEIGHT;
			case 'favorite': return FAVORITE_WEIGHT;
			case 'post': return POST_WEIGHT;
			case 'reaction':
				// Custom/emoji reactions (":name:" / ":name@host:") are more deliberate than a generic
				// unicode reaction, so they signal stronger preference.
				return reaction != null && reaction.includes(':') ? REACTION_RARE_WEIGHT : REACTION_NORMAL_WEIGHT;
			default: return REACTION_NORMAL_WEIGHT;
		}
	}

	/** The user's 0..2 interest-update coefficient for an engagement kind (renote → "boost"). 1 by default. */
	@bindThis
	private engagementCoeff(settings: RecommendationSettings, kind: EngagementKind): number {
		switch (kind) {
			case 'reply': return settings.engagement.reply;
			case 'renote': return settings.engagement.boost;
			case 'favorite': return settings.engagement.favorite;
			case 'post': return settings.engagement.post;
			case 'reaction': return settings.engagement.reaction;
			default: return 1;
		}
	}

	/**
	 * The effective (sanitized, fully-populated) recommendation settings for a user, read through the
	 * 30-minute user-profile cache so the hot path stays cheap. Falls back to all-defaults on any miss.
	 */
	@bindThis
	public async getEffectiveRecSettings(userId: MiUser['id']): Promise<RecommendationSettings> {
		try {
			const profile = await this.cacheService.userProfileCache.fetch(userId);
			return mergeRecSettings(profile.recommendationSettings);
		} catch {
			return mergeRecSettings(null);
		}
	}

	@bindThis
	public async getInterestVectors(userId: MiUser['id']): Promise<{ mm: number[] | null; txt: number[] | null }> {
		// Serving just reads the stored per-modality vectors — kept fresh in real time by the EMA. Only
		// when neither exists yet (first ever pull) do we bootstrap with a full batch build.
		const [mmRaw, txtRaw] = await this.redisForTimelines.mget(`rec:uvec:mm:${userId}`, `rec:uvec:txt:${userId}`);
		const parse = (raw: string | null): number[] | null => {
			if (raw == null) return null;
			try { return JSON.parse(raw) as number[]; } catch { return null; }
		};
		const mm = parse(mmRaw);
		const txt = parse(txtRaw);
		if (mm == null && txt == null) return this.recomputeInterestVectors(userId);
		return { mm, txt };
	}

	/**
	 * The average interest vector over a random sample of users (per modality), cached instance-wide. Used
	 * as the ANN query for users who don't yet have their own vector for that modality — so a new user gets
	 * "what a typical user is interested in" (still personalized-shaped, still pure ANN) rather than a
	 * generic quality/news pool. Returns null only if no users have a vector for that modality yet.
	 */
	@bindThis
	public async getAverageUserVector(modality: Modality): Promise<number[] | null> {
		const cacheKey = `rec:avgvec:${modality}`;
		const cached = await this.redisForTimelines.get(cacheKey);
		if (cached != null) {
			try { const v = JSON.parse(cached) as number[]; if (Array.isArray(v) && v.length > 0) return v; } catch { /* recompute */ }
		}
		// Sample random users known to have engagement (rec:users), then average their stored vectors.
		const sampleUserIds = await this.redisForTimelines.srandmember('rec:users', AVGVEC_SAMPLE_MAX);
		if (sampleUserIds.length === 0) return null;
		const raws = await this.redisForTimelines.mget(...sampleUserIds.map(uid => `rec:uvec:${modality}:${uid}`));
		let sum: number[] | null = null;
		let n = 0;
		for (const raw of raws) {
			if (raw == null) continue;
			let v: number[] | null = null;
			try { v = JSON.parse(raw) as number[]; } catch { continue; }
			if (!Array.isArray(v) || v.length === 0) continue;
			sum ??= new Array<number>(v.length).fill(0);
			if (v.length !== sum.length) continue;
			for (let i = 0; i < sum.length; i++) sum[i] += v[i];
			n++;
		}
		if (sum == null || n === 0) return null;
		const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return null;
		const avg = sum.map(x => x / norm);
		await this.redisForTimelines.set(cacheKey, JSON.stringify(avg), 'EX', AVGVEC_TTL_SEC);
		return avg;
	}

	/**
	 * EMA-replays the engaged notes (oldest→newest) within ONE modality's embeddings, then applies the
	 * Rocchio soft-negative term using same-modality negatives. Returns a unit vector or null.
	 */
	/**
	 * Builds a user's topic-interest array {topic: +1|-1} from the topics of the notes they engaged with.
	 * Top-{@link TOPIC_TOP_N} topics by summed engagement weight get +1; {@link TOPIC_DOWNRANK_DEFAULT}
	 * (news/politics) get -1 by default, but a default-penalized topic that's also top-N is promoted to +1
	 * (the user clearly likes it). Topics not mentioned are absent (= 0). Returns {} only when there's no
	 * engagement at all (caller deletes the key). Notes without a topic yet are simply ignored.
	 */
	@bindThis
	private async computeTopicInterest(parsed: { weight: number; noteId: string }[]): Promise<Record<string, 1 | -1>> {
		const out: Record<string, 1 | -1> = {};
		const ids = parsed.map(p => p.noteId);
		if (ids.length === 0) return out;

		// Editorial default: news/politics down-ranked unless the user engages with them enough (below).
		for (const t of TOPIC_DOWNRANK_DEFAULT) out[t] = -1;

		const rows = await this.noteTopicsRepository.createQueryBuilder('t')
			.select('t.noteId', 'noteId').addSelect('t.topic', 'topic')
			.where('t.noteId IN (:...ids)', { ids })
			.getRawMany<{ noteId: string; topic: string }>();
		const topicOf = new Map(rows.map(r => [r.noteId, r.topic]));

		const weightByTopic = new Map<string, number>();
		for (const p of parsed) {
			const topic = topicOf.get(p.noteId);
			if (topic == null) continue;
			weightByTopic.set(topic, (weightByTopic.get(topic) ?? 0) + p.weight);
		}
		// Top-N engaged topics → +1 (overrides the default penalty for news/politics).
		const topN = [...weightByTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPIC_TOP_N);
		for (const [topic] of topN) out[topic] = 1;
		return out;
	}

	@bindThis
	private buildModalityVector(parsed: { weight: number; noteId: string }[], vectors: Map<string, number[]>, negVecs: number[][], strongNegVecs: number[][] = []): number[] | null {
		let dim = 0;
		for (const v of vectors.values()) { dim = v.length; break; }
		if (dim === 0) return null;

		// Positive centroid: a LINEAR-decay-weighted mean over the most recent INTEREST_WINDOW engagements
		// (× each engagement's signal weight). Unlike a steep EMA, older interactions still count
		// substantially — the most-recent engagement is ≈2% of the total and the ~50th-most-recent ≈1% —
		// so the vector reflects sustained taste, not just the last handful of likes. `parsed` is
		// newest-first, so the position weight decays as the index grows and hits 0 past the window.
		const acc = new Array<number>(dim).fill(0);
		let totalW = 0;
		for (let i = 0; i < parsed.length; i++) {
			const posW = INTEREST_WINDOW - i;
			if (posW <= 0) break;
			const vec = vectors.get(parsed[i].noteId);
			if (!vec || vec.length !== dim) continue;
			const w = posW * parsed[i].weight;
			for (let d = 0; d < dim; d++) acc[d] += w * vec[d];
			totalW += w;
		}
		if (totalW === 0) return null;
		const pos = unit(acc);
		if (pos == null) return null;

		const meanOf = (vecs: number[][]): { sum: number[]; count: number } => {
			let count = 0;
			const sum = new Array<number>(dim).fill(0);
			for (const vec of vecs) {
				if (vec.length !== dim) continue;
				for (let d = 0; d < dim; d++) sum[d] += vec[d];
				count++;
			}
			return { sum, count };
		};
		const soft = meanOf(negVecs);
		const strong = meanOf(strongNegVecs); // explicit "not interested" dislikes — pulled harder

		const result = pos.map((x, d) => x
			- (soft.count > 0 ? SOFT_NEGATIVE_WEIGHT * (soft.sum[d] / soft.count) : 0)
			- (strong.count > 0 ? STRONG_NEGATIVE_WEIGHT * (strong.sum[d] / strong.count) : 0));
		const norm = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return null;
		return result.map(x => x / norm);
	}

	/**
	 * Full (re)build of BOTH per-modality interest vectors from the engaged list (the batch counterpart
	 * to the real-time EMA). Also recomputes the modality engagement counts that drive the blend ratio.
	 * Used to bootstrap/cold-start and as the daily reconciliation that folds in late-embedded likes.
	 */
	@bindThis
	public async recomputeInterestVectors(userId: MiUser['id']): Promise<{ mm: number[] | null; txt: number[] | null }> {
		const entries = await this.redisForTimelines.lrange(`rec:engaged:${userId}`, 0, ENGAGED_MAX - 1);
		if (entries.length === 0) {
			await this.redisForTimelines.del(`rec:dirty:${userId}`);
			return { mm: null, txt: null };
		}

		const parsed = entries.map(e => {
			const idx = e.indexOf(':');
			const weight = Number(e.slice(0, idx)) || REACTION_NORMAL_WEIGHT;
			return { weight, noteId: e.slice(idx + 1) };
		});
		const engagedSet = new Set(parsed.map(p => p.noteId));

		// Same-modality soft negatives: most-recently shown-but-not-engaged notes.
		const recentlyShown = await this.redisForTimelines.zrevrange(`rec:pushed:${userId}`, 0, NEG_SAMPLE_MAX * 2);
		const negIds = recentlyShown.filter(id => !engagedSet.has(id)).slice(0, NEG_SAMPLE_MAX);
		// Explicit "not interested" dislikes: STRONG negatives, pulled much harder than the soft ones.
		const dislikedRaw = await this.redisForTimelines.zrevrange(`rec:disliked:${userId}`, 0, DISLIKE_SAMPLE_MAX);
		const dislikedIds = dislikedRaw.filter(id => !engagedSet.has(id));

		const allIds = [...engagedSet, ...negIds, ...dislikedIds];
		const [mmVecs, txtVecs] = await Promise.all([
			this.milvusService.getNoteVectors(allIds, 'mm'),
			this.milvusService.getNoteVectors(allIds, 'txt'),
		]);

		const mmNeg = negIds.map(id => mmVecs.get(id)).filter((v): v is number[] => v != null);
		const txtNeg = negIds.map(id => txtVecs.get(id)).filter((v): v is number[] => v != null);
		const mmStrongNeg = dislikedIds.map(id => mmVecs.get(id)).filter((v): v is number[] => v != null);
		const txtStrongNeg = dislikedIds.map(id => txtVecs.get(id)).filter((v): v is number[] => v != null);
		const mm = this.buildModalityVector(parsed, mmVecs, mmNeg, mmStrongNeg);
		const txt = this.buildModalityVector(parsed, txtVecs, txtNeg, txtStrongNeg);

		// Modality engagement counts (for the blend ratio): which collection each engaged note lives in.
		let mmCount = 0;
		let txtCount = 0;
		for (const p of parsed) {
			if (mmVecs.has(p.noteId)) mmCount++;
			else if (txtVecs.has(p.noteId)) txtCount++;
		}

		// Topic interest array {1,0,-1}, derived from the topics of the user's engaged notes.
		const topicInterest = await this.computeTopicInterest(parsed);

		const pipe = this.redisForTimelines.multi();
		if (mm != null) pipe.set(`rec:uvec:mm:${userId}`, JSON.stringify(mm), 'EX', PUSHED_TTL_SEC); else pipe.del(`rec:uvec:mm:${userId}`);
		if (txt != null) pipe.set(`rec:uvec:txt:${userId}`, JSON.stringify(txt), 'EX', PUSHED_TTL_SEC); else pipe.del(`rec:uvec:txt:${userId}`);
		if (Object.keys(topicInterest).length > 0) pipe.set(`rec:topicint:${userId}`, JSON.stringify(topicInterest), 'EX', PUSHED_TTL_SEC); else pipe.del(`rec:topicint:${userId}`);
		pipe.del(`rec:modality:${userId}`);
		if (mmCount > 0) pipe.hset(`rec:modality:${userId}`, 'mm', mmCount);
		if (txtCount > 0) pipe.hset(`rec:modality:${userId}`, 'txt', txtCount);
		if (mmCount > 0 || txtCount > 0) pipe.expire(`rec:modality:${userId}`, PUSHED_TTL_SEC);
		pipe.del(`rec:dirty:${userId}`);
		await pipe.exec();

		// Mirror the rebuilt vectors into the user-vector ANN collections (Tier B taste-neighbour search).
		// Done here, on the batch recompute, rather than on every engagement EMA — neighbour lookups
		// tolerate up-to-a-day staleness and this keeps Milvus user-collection writes bounded. Best-effort.
		if (this.milvusService.enabled) {
			if (mm != null) this.milvusService.upsertUserVector(userId, mm, 'mm').catch(() => { /* best-effort */ });
			if (txt != null) this.milvusService.upsertUserVector(userId, txt, 'txt').catch(() => { /* best-effort */ });
		}

		return { mm, txt };
	}

	/**
	 * Prebuilds interest vectors for every user who has engaged. Run daily (and on-demand by an
	 * admin) so the per-request path usually finds a fresh vector. This is language-independent — a
	 * user's interest vector doesn't depend on the UI locale — so unlike the candidate queue it's
	 * safe to compute ahead of time. Rarely-online users cost a single cheap recompute.
	 */
	@bindThis
	public async recomputeAllUserVectors(): Promise<number> {
		const users = await this.redisForTimelines.smembers('rec:users');
		let count = 0;
		for (const userId of users) {
			try {
				await this.recomputeInterestVectors(userId);
				count++;
			} catch (err) {
				this.logger.warn(`recompute for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.logger.info(`recomputed ${count} user interest vector(s)`);
		return count;
	}

	/** Reads the user's {topic: +1|-1} interest array (rec:topicint); empty when none computed yet. */
	@bindThis
	public async getTopicInterest(userId: MiUser['id']): Promise<Record<string, number>> {
		try {
			const raw = await this.redisForTimelines.get(`rec:topicint:${userId}`);
			if (raw == null) return {};
			const o = JSON.parse(raw) as unknown;
			return (typeof o === 'object' && o != null) ? o as Record<string, number> : {};
		} catch {
			return {};
		}
	}

	/**
	 * The user's effective topic interest, surfaced for the settings UI: the auto-derived array
	 * (rec:topicint, learned from engagement) overlaid with their explicit interest/disinterest picks
	 * (which win). Returns the topics that net out to interested (+1) and not-interested (−1), filtered to
	 * the known taxonomy. Lets the settings page show what the recommender currently thinks, pre-filled.
	 */
	@bindThis
	public async getUserTopicInterest(userId: MiUser['id']): Promise<{ interested: Topic[]; disinterested: Topic[] }> {
		const [auto, settings] = await Promise.all([
			this.getTopicInterest(userId),
			this.getEffectiveRecSettings(userId),
		]);
		const merged: Record<string, number> = { ...auto };
		for (const t of settings.interestTopics) merged[t] = 1;
		for (const t of settings.disinterestTopics) merged[t] = -1;

		const known = new Set<string>(TOPIC_LABELS);
		const interested: Topic[] = [];
		const disinterested: Topic[] = [];
		for (const [topic, v] of Object.entries(merged)) {
			if (!known.has(topic)) continue;
			if (v > 0) interested.push(topic as Topic);
			else if (v < 0) disinterested.push(topic as Topic);
		}
		return { interested, disinterested };
	}

	// --- author produce-centroid (Tier A) ---

	/**
	 * Folds one freshly-embedded note vector into its author's per-modality produce centroid (the
	 * "author affinity" prior). The centroid is stored DURABLY in a dedicated Milvus collection (NOT only
	 * the rolling note-vector store), so it's never lost to eviction. Called from the embed processor for
	 * every public note. The first time an author is seen we compute the centroid from their ENTIRE
	 * available history (all their note vectors) rather than starting at a single note; after that we just
	 * EMA-update it with each new note. Best-effort; a rare concurrent lost update is smoothed by the EMA.
	 */
	@bindThis
	public async foldAuthorCentroid(authorId: MiUser['id'], modality: Modality, vector: number[]): Promise<void> {
		try {
			const existing = (await this.milvusService.getAuthorVectors([authorId], modality)).get(authorId);
			let next: number[] | null;
			let n: number;
			if (existing != null && existing.v.length === vector.length) {
				// Incremental EMA update on the durable centroid.
				const blended = existing.v.map((x, i) => (1 - AUTHOR_CENTROID_EMA_ALPHA) * x + AUTHOR_CENTROID_EMA_ALPHA * vector[i]);
				next = unit(blended);
				n = existing.n + 1;
			} else {
				// No centroid yet → compute it from the author's ENTIRE available history (the just-embedded
				// note is already in the store, so it's included), not just this one note.
				const all = await this.milvusService.getAuthorNoteVectors(authorId, modality, AUTHOR_HISTORY_CAP);
				const dim = vector.length;
				const sum = new Array<number>(dim).fill(0);
				let cnt = 0;
				for (const v of all) { if (v.length !== dim) continue; for (let d = 0; d < dim; d++) sum[d] += v[d]; cnt++; }
				next = cnt > 0 ? unit(sum) : unit(vector);
				n = Math.max(cnt, 1);
			}
			if (next == null) return;
			await this.milvusService.upsertAuthorVector(authorId, next, n, modality);
		} catch (err) {
			this.logger.warn(`foldAuthorCentroid failed for ${authorId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Batch-reads author produce centroids for one modality from the durable Milvus collection. Returns a
	 * map authorId → centroid; authors with no centroid yet (or fewer than AUTHOR_CENTROID_MIN_NOTES posts
	 * folded in) are simply absent, so the caller falls back to note-sim for them.
	 */
	@bindThis
	public async getAuthorCentroids(authorIds: string[], modality: Modality): Promise<Map<string, number[]>> {
		const out = new Map<string, number[]>();
		const ids = [...new Set(authorIds)];
		if (ids.length === 0) return out;
		try {
			const vecs = await this.milvusService.getAuthorVectors(ids, modality);
			for (const [id, { v, n }] of vecs) {
				if (Array.isArray(v) && n >= AUTHOR_CENTROID_MIN_NOTES) out.set(id, v);
			}
		} catch (err) {
			this.logger.warn(`getAuthorCentroids failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return out;
	}

	/**
	 * One-off backfill: (re)computes the durable author produce-centroid for every author with recent
	 * public notes, from their entire available note history. Run once after enabling the durable author
	 * collection; thereafter centroids stay fresh via foldAuthorCentroid on each note embed. Fire-and-forget
	 * (progress in the 'recommendation' log).
	 */
	@bindThis
	public async backfillAuthorCentroids(sinceDays = 70): Promise<{ authors: number; computed: number }> {
		const minId = this.idService.gen(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
		this.logger.info(`backfillAuthorCentroids: collecting distinct authors of public notes since ${sinceDays}d…`);
		const rows = await this.notesRepository.createQueryBuilder('note')
			.select('DISTINCT note."userId"', 'userId')
			.where('note.id > :minId', { minId })
			.andWhere('note.visibility = :v', { v: 'public' })
			.getRawMany<{ userId: string }>();
		const authorIds = rows.map(r => r.userId);
		this.logger.info(`backfillAuthorCentroids: ${authorIds.length} authors to process`);
		let computed = 0;
		for (let i = 0; i < authorIds.length; i++) {
			const authorId = authorIds[i];
			for (const modality of ['mm', 'txt'] as Modality[]) {
				try {
					const all = await this.milvusService.getAuthorNoteVectors(authorId, modality, AUTHOR_HISTORY_CAP);
					if (all.length === 0) continue;
					const dim = all[0].length;
					const sum = new Array<number>(dim).fill(0);
					let cnt = 0;
					for (const v of all) { if (v.length !== dim) continue; for (let d = 0; d < dim; d++) sum[d] += v[d]; cnt++; }
					if (cnt === 0) continue;
					const centroid = unit(sum);
					if (centroid == null) continue;
					await this.milvusService.upsertAuthorVector(authorId, centroid, cnt, modality);
					computed++;
				} catch { /* best-effort per author/modality */ }
			}
			if ((i + 1) % 500 === 0) this.logger.info(`backfillAuthorCentroids: ${i + 1}/${authorIds.length} authors, ${computed} centroids`);
		}
		this.logger.info(`backfillAuthorCentroids: done — ${computed} centroids across ${authorIds.length} authors`);
		return { authors: authorIds.length, computed };
	}
}
