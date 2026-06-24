/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { RecFactorKey } from '@/core/rec-settings.js';

/**
 * The learned ("heavy") ranker contract, shared by the serving path
 * ({@link RecommendationService.rankCandidates}) and the offline learner
 * (`scripts/learn-coef.mjs`). The design mirrors Twitter's the-algorithm heavy ranker:
 *
 *   1. A set of per-engagement-type predictors estimate P(outcome | features) — here a calibrated
 *      pointwise logistic head per outcome, learned offline from the impression log.
 *   2. The final ranking score is the value-weighted sum of those probabilities:
 *          score = Σ_e  value_e · P(e | features)
 *      where `value_e` is an admin-set product weight for how much the instance values each outcome
 *      (a reply is worth far more than a passive like; an explicit "not interested" is strongly
 *      negative — exactly Twitter's reply=13.5 / fav=0.5 / report=-369 separation of "how likely"
 *      (learned) from "how much we care" (hand-set)).
 *
 * Until a model is trained the serving path falls back to the legacy hand-tuned additive score; the
 * admin `recommendationRankerWeight` ∈ [0,1] ramps from hand-tuned (0) to learned (1) via rank fusion,
 * so shipping the model is a no-op until it's deliberately turned up.
 */

/**
 * Feature inputs to every predictor head. These are exactly the raw per-note signals computed at rank
 * time (each already in a bounded range), so the learner and the serving path agree on the vector.
 * Order is significant only as documentation — the model carries its own feature list for forward-compat.
 */
export const RANKER_FEATURES = [
	'relevancy', // user↔note cosine ∈ [0,1]
	'authorAffinity', // user↔author-centroid cosine ∈ [0,1]
	'quality', // content quality ∈ [0,1]
	'popularity', // soft-normalized engagement ∈ [0,1]
	'recency', // freshness decay ∈ [0,1]
	'shortness', // short-post signal ∈ [0,1]
	'overTag', // over-tagging signal ∈ [0,1]
	'isReply', // standalone-reply flag ∈ {0,1}
	'topic', // topic interest ∈ {-1,0,1}
	'followed', // author is followed ∈ {0,1}
	'cfHit', // a taste-neighbour engaged this ∈ {0,1}
	'mm', // multimodal (has image) ∈ {0,1}
	'langW', // language-preference weight ∈ [0,1]
] as const;
export type RankerFeatureKey = typeof RANKER_FEATURES[number];

/**
 * Maps each user-facing factor coefficient ({@link RecFactorKey}, the per-user 0..2 knob) to the model
 * feature it scales, so user control is preserved: the coefficient multiplies its feature INPUT before
 * the predictors see it (coeff 0 ⇒ the factor is zeroed out of every prediction, 2 ⇒ doubled influence).
 * Features with no user knob (`mm`, `langW`) are structural and always pass through at coefficient 1.
 */
export const FACTOR_TO_FEATURE: Record<RecFactorKey, RankerFeatureKey> = {
	relevancy: 'relevancy',
	authorAffinity: 'authorAffinity',
	quality: 'quality',
	popularity: 'popularity',
	recency: 'recency',
	shortPostPenalty: 'shortness',
	overTagPenalty: 'overTag',
	replyPenalty: 'isReply',
	topicPreference: 'topic',
	followed: 'followed',
	similarUsers: 'cfHit',
};

/**
 * Engagement outcomes the heavy ranker predicts, each with an admin-set product value weight. Defaults
 * mirror Twitter's published heavy-ranker weights (fav 0.5, retweet 1.0, reply 13.5, reply-engaged-by-
 * author 75.0, good-click/dwell ≈ 11, negative-feedback −74), mapped onto Sharkey's engagement kinds:
 *  - reaction  ≈ like/fav         (a passive emoji reaction)
 *  - favorite  ≈ a save/bookmark  (more intentional than a reaction)
 *  - renote    ≈ retweet
 *  - reply     ≈ reply
 *  - dwell     ≈ "good click"      (the note held the viewer's attention; from client dwell time)
 *  - replyEngagedByAuthor          (the viewer replied AND the author engaged the reply back — the
 *                                   single highest-value positive, exactly as on Twitter)
 *  - dislike   ≈ negative feedback (explicit "not interested" / mute — strongly negative)
 */
export const RANKER_ENGAGEMENTS = [
	'reaction', 'favorite', 'renote', 'reply', 'dwell', 'replyEngagedByAuthor', 'dislike',
] as const;
export type RankerEngagementKey = typeof RANKER_ENGAGEMENTS[number];

export const DEFAULT_ENGAGEMENT_VALUES: Record<RankerEngagementKey, number> = {
	reaction: 0.5,
	favorite: 1.0,
	renote: 1.0,
	reply: 13.5,
	dwell: 11.0,
	replyEngagedByAuthor: 75.0,
	dislike: -74.0,
};

/** One predictor head: a logistic regression (bias + per-feature weights) over {@link RANKER_FEATURES}. */
export type RankerHead = {
	bias: number;
	weights: Partial<Record<RankerFeatureKey, number>>;
};

/**
 * A trained ranker model. Two parts, both written by the offline learner and stored as JSON in
 * `meta.recommendationRankerModel`:
 *  - `weights`: the PRIMARY output — a learned ADDITIVE per-feature weight (signed) fit by value-
 *    regression (target = Σ valueₑ·outcomeₑ). These replace/blend the hand-tuned factor weights in the
 *    additive ranking score, so the score stays fully additive and each feature's contribution is exact
 *    and user-controllable (the per-user coefficient scales the contribution; see {@link blendWeights}).
 *  - `heads`: OPTIONAL per-engagement logistic heads, used ONLY for the "predicted engagement" insight
 *    panel in the "why recommended?" view — they do NOT drive ranking.
 */
export type RankerModel = {
	version: number;
	/** Feature order the model was trained on (kept so weights/heads evaluate forward-compatibly). */
	features: RankerFeatureKey[];
	/** Learned additive per-feature weights (signed); the primary ranking model. */
	weights?: Partial<Record<RankerFeatureKey, number>>;
	/** Optional per-engagement logistic heads, for the display-only engagement insight panel. */
	heads?: Partial<Record<RankerEngagementKey, RankerHead>>;
	/** ISO timestamp the model was trained, for operational visibility. */
	trainedAt?: string;
};

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Blends a hand-tuned signed weight map with a learned one by `lambda` ∈ [0,1] (0 = pure hand, 1 = pure
 * learned), after L1-normalising the learned weights to the hand map's total magnitude so the two live on
 * a comparable scale (ranking is scale-invariant, but the blend and the displayed contributions should
 * interpolate sensibly). Keys come from `hand`; a learned weight absent/0 just leaves the hand value.
 */
export function blendWeights<K extends string>(hand: Record<K, number>, learned: Partial<Record<K, number>>, lambda: number): Record<K, number> {
	const keys = Object.keys(hand) as K[];
	if (lambda <= 0) return { ...hand };
	const handL1 = keys.reduce((s, k) => s + Math.abs(hand[k]), 0);
	const learnedL1 = keys.reduce((s, k) => s + Math.abs(learned[k] ?? 0), 0);
	const scale = learnedL1 > 0 ? handL1 / learnedL1 : 0;
	const out = {} as Record<K, number>;
	for (const k of keys) out[k] = (1 - lambda) * hand[k] + lambda * (learned[k] ?? 0) * scale;
	return out;
}

/** Evaluates one logistic head against a feature vector, returning a probability ∈ (0,1). */
export function predictHead(head: RankerHead, x: Partial<Record<RankerFeatureKey, number>>): number {
	let z = head.bias;
	for (const f of RANKER_FEATURES) {
		const w = head.weights[f];
		if (w == null) continue;
		z += w * (x[f] ?? 0);
	}
	return sigmoid(z);
}

/**
 * The heavy-ranker score for one candidate: Σ_e value_e · P(e | x). Heads absent from the model
 * contribute nothing. `values` are the admin value weights (falling back to {@link DEFAULT_ENGAGEMENT_VALUES}).
 * Returns both the scalar score and the per-engagement predicted probabilities (for the breakdown view).
 */
export function scoreWithModel(
	model: RankerModel,
	x: Partial<Record<RankerFeatureKey, number>>,
	values: Record<RankerEngagementKey, number>,
): { score: number; probs: Partial<Record<RankerEngagementKey, number>> } {
	let score = 0;
	const probs: Partial<Record<RankerEngagementKey, number>> = {};
	for (const e of RANKER_ENGAGEMENTS) {
		const head = model.heads?.[e];
		if (head == null) continue;
		const p = predictHead(head, x);
		probs[e] = p;
		score += (values[e] ?? 0) * p;
	}
	return { score, probs };
}

/**
 * Sanitizes a possibly-partial value-weight object (from the meta column) into a complete one, falling
 * back to the Twitter-derived defaults for any missing/invalid entry. Value weights are unbounded
 * (negative for dislike), so we only require finiteness.
 */
export function mergeEngagementValues(partial: Partial<Record<RankerEngagementKey, number>> | null | undefined): Record<RankerEngagementKey, number> {
	const out = { ...DEFAULT_ENGAGEMENT_VALUES };
	if (partial) {
		for (const e of RANKER_ENGAGEMENTS) {
			const v = partial[e];
			if (typeof v === 'number' && Number.isFinite(v)) out[e] = v;
		}
	}
	return out;
}

/**
 * Parses the stored model JSON (meta column) into a {@link RankerModel}, or null if absent/malformed.
 * A malformed model must never break serving — the caller falls back to the hand-tuned score.
 */
export function parseRankerModel(raw: unknown): RankerModel | null {
	if (raw == null) return null;
	try {
		const o = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Partial<RankerModel>;
		if (o == null || typeof o !== 'object') return null;
		const features = Array.isArray(o.features) ? o.features.filter((f): f is RankerFeatureKey => (RANKER_FEATURES as readonly string[]).includes(f)) : [...RANKER_FEATURES];

		// Primary: additive per-feature weights (signed). Keep only finite numbers on known features.
		let weights: Partial<Record<RankerFeatureKey, number>> | undefined;
		if (o.weights != null && typeof o.weights === 'object') {
			weights = {};
			for (const ff of RANKER_FEATURES) {
				const w = o.weights[ff];
				if (typeof w === 'number' && Number.isFinite(w)) weights[ff] = w;
			}
			if (Object.keys(weights).length === 0) weights = undefined;
		}

		// Optional: per-engagement logistic heads (display-only insight panel).
		let heads: Partial<Record<RankerEngagementKey, RankerHead>> | undefined;
		if (o.heads != null && typeof o.heads === 'object') {
			heads = {};
			for (const e of RANKER_ENGAGEMENTS) {
				const h = o.heads[e];
				if (h == null || typeof h.bias !== 'number' || h.weights == null) continue;
				heads[e] = { bias: h.bias, weights: h.weights };
			}
			if (Object.keys(heads).length === 0) heads = undefined;
		}

		// A model is usable only if it has at least the additive weights (or, legacy, some heads).
		if (weights == null && heads == null) return null;
		return { version: typeof o.version === 'number' ? o.version : 1, features, weights, heads, trainedAt: typeof o.trainedAt === 'string' ? o.trainedAt : undefined };
	} catch {
		return null;
	}
}
