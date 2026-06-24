/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/_.js';
import type { RecFactorKey } from '@/core/rec-settings.js';
import type { RankerEngagementKey } from '@/core/rec-ranker.js';
import type { CandidateSource, AdditiveFactor } from './constants.js';

// NSFW is no longer a score penalty: it's a hard per-user filter. When the user's `recommendNsfw` setting
// is off (the default), notes carrying sensitive media are EXCLUDED from the feed entirely (see the
// `excludeSensitive` filter in loadAndFilterNotes); when on, they're served with no penalty at all. (CW
// text-only posts are unaffected — only attached drive files flagged isSensitive count.)

/** Per-note content features, cached in Redis (`rec:feat:{noteId}`), computed off the hot path. */
export type NoteFeatures = {
	/** LLM interestingness 1-5, or null if unscored. */
	q: number | null;
	/** Deterministic structural quality ∈ [0,1] (always present; fallback when q is null). */
	sq: number;
	readableLength: number;
	readableRatio: number;
	hasImage: boolean;
	imageCount: number;
};

/**
 * Serve-time score breakdown, carried through the queue so impressions can log training features AND the
 * "why was this recommended?" client view can render a per-factor table without re-ranking. Every raw
 * factor that fed the score is captured here, alongside the user's per-factor coefficients (`coeffs`) as
 * they were at rank time, so {@link RecommendationService.buildBreakdown} can reconstruct the whole table.
 */
export type CandidateFeatures = {
	ann: number;
	/** user↔author-centroid cosine ∈ [0,1] (the author prior), or note-sim when no centroid yet. */
	authorSim: number;
	/** collaborative-filtering retrieval score (taste-neighbour weighted), 0 if not CF-sourced. */
	cfScore: number;
	quality: number;
	/** freshness signal ∈ (0,1] (1 = within the recency plateau, decaying afterwards). */
	recency: number;
	langW: number;
	alpha: number;
	score: number;
	followed: boolean;
	mm: boolean;
	// --- extended breakdown (for the transparency view) ---
	/** soft-normalized engagement/popularity ∈ [0,1]. */
	engagement?: number;
	/** short-post penalty signal ∈ [0,1] (1 = very short; 0 for image posts / full-length prose). */
	shortness?: number;
	/** over-tagging penalty signal ∈ [0,1] (0 when within the soft hashtag limit). */
	overTag?: number;
	/** standalone-reply penalty signal ∈ {0,1}. */
	isReply?: number;
	/** user's topic interest in this note's topic ∈ {-1,0,1}. */
	topicV?: number;
	/** the note's (LLM-inferred) topic slug. */
	topic?: string | null;
	/** whether a taste-neighbour engaged with this note (the CF bonus applies). */
	cfHit?: boolean;
	/** the user's per-factor coefficients applied at rank time. */
	coeffs?: Record<RecFactorKey, number>;
	/** the effective per-factor weights used at rank time (hand-tuned blended with the learned model by λ);
	 * the breakdown shows these so the "base factor" column reflects the up-to-date learned coefficient. */
	weights?: Record<AdditiveFactor, number>;
	/** true for notes from the home-timeline follows lane (shown by the breakdown as type 'following',
	 * not score-ranked). */
	fromFollows?: boolean;
	// --- learned heavy-ranker outputs (present only when a model is active) ---
	/** the learned ranker's value-weighted score (Σ value_e · P_e), if a model was applied. */
	learnedScore?: number;
	/** the per-engagement predicted probabilities from the learned heads, for the breakdown view. */
	probs?: Partial<Record<RankerEngagementKey, number>>;
	/** the blend λ in effect at rank time (0 = pure hand-tuned, 1 = pure learned). */
	rankerWeight?: number;
};

/**
 * One row of the "why was this recommended?" table. Most factors are ADDITIVE (`kind: 'add'`): a signed
 * contribution `raw · weight · coeff`; the additive rows sum to the content subtotal. Recency is
 * MULTIPLICATIVE (`kind: 'mult'`): `effect` is the multiplier applied to that subtotal to give the score.
 */
export type RecommendationBreakdownRow = {
	/** i18n key suffix under `_recommendations._factors` (e.g. 'relevancy'). */
	key: RecFactorKey;
	/** how the factor combines: an additive contribution, or a multiplier on the running score. */
	kind: 'add' | 'mult';
	/** the raw signal: cosine/quality ∈ [0,1], topic ∈ {-1,0,1}, penalties ∈ [-1,0], flags 0/1, or (for the
	 * recency multiplier) the global time-decay ∈ (0,1]. */
	raw: number;
	/** the factor's positive base weight (1 for the recency multiplier). */
	weight: number;
	/** the user's 0..2 coefficient. */
	coeff: number;
	/** additive factors: the contribution raw·weight·coeff. Multiplicative: the applied multiplier. */
	effect: number;
};

/**
 * One predicted-engagement row of the learned ("heavy") ranker's contribution to the score: the
 * outcome's predicted probability, its admin value weight, and their product (the contribution to
 * `Σ value_e · P_e`). Present only when a learned model was applied.
 */
export type RecommendationEngagementRow = {
	/** engagement outcome key (i18n under `_recommendations._engagements`). */
	key: RankerEngagementKey;
	/** predicted probability ∈ (0,1). */
	prob: number;
	/** the outcome's product value weight (admin-set; reply ≫ like, dislike negative). */
	value: number;
	/** contribution to the learned score = prob · value. */
	effect: number;
};

/** The full per-note recommendation explanation shipped to the client as `_recommendationFactors_`. */
export type RecommendationBreakdown = {
	/** why this note is in the feed: 'following' = from the home-timeline follows lane (not scored, no
	 * factor table); 'score' = score-ranked discovery (the factor table applies). */
	type: 'following' | 'score';
	/** final ranking score (content subtotal × recency multiplier). 0 for a 'following' note. */
	score: number;
	/** sum of the additive factor contributions, before the recency multiplier. 0 for 'following'. */
	subtotal: number;
	/** the note's (LLM-inferred) topic slug, or null. */
	topic: string | null;
	rows: RecommendationBreakdownRow[];
	/** how the note was ranked: 'hand' (additive), 'learned' (pure model), or 'blend' (rank-fused). */
	mode?: 'hand' | 'learned' | 'blend';
	/** the learned ranker's value-weighted score Σ value_e · P_e, when a model was applied. */
	learnedScore?: number;
	/** the blend λ in effect (0 = pure hand-tuned, 1 = pure learned). */
	rankerWeight?: number;
	/** per-engagement predicted-probability rows of the learned ranker, when a model was applied. */
	engagements?: RecommendationEngagementRow[];
};

/** A page of recommended notes plus, for logged-in users, a per-note "why recommended?" breakdown (by note id). */
export type RecommendationPage = { notes: MiNote[]; breakdowns: Map<string, RecommendationBreakdown> };

export type ScoredCandidate = {
	noteId: string;
	source: CandidateSource;
	annScore: number;
	feat?: CandidateFeatures;
};
