/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { defineAsyncComponent } from 'vue';
import type * as Misskey from 'misskey-js';
import * as os from '@/os.js';

/** Factor keys, in sync with RecFactorKey in the backend (packages/backend/src/core/rec-settings.ts). */
export type RecFactorKey =
	| 'relevancy' | 'authorAffinity' | 'quality' | 'popularity'
	| 'recency' | 'shortPostPenalty' | 'overTagPenalty' | 'replyPenalty'
	| 'topicPreference' | 'followed' | 'similarUsers';

/** One row of the "why was this recommended?" table — mirrors the backend RecommendationBreakdownRow.
 * Most factors are additive (`kind: 'add'`, contribution = raw · weight · coeff; the additive rows sum to
 * the subtotal). Recency is multiplicative (`kind: 'mult'`): its `effect` is the multiplier on the subtotal. */
export type RecommendationBreakdownRow = {
	key: RecFactorKey;
	kind: 'add' | 'mult';
	raw: number;
	weight: number;
	coeff: number;
	effect: number;
};

/** The full per-note recommendation explanation, shipped on the note as `_recommendationFactors_`. */
export type RecommendationEngagementRow = {
	key: string;
	prob: number;
	value: number;
	effect: number;
};

export type RecommendationBreakdown = {
	/** why this note is in the feed: 'following' = from your home-timeline follows (not scored, no factor
	 * table); 'score' = score-ranked discovery (the factor table applies). */
	type: 'following' | 'score';
	/** final score = subtotal × recency multiplier (the hand-tuned score). */
	score: number;
	/** sum of the additive factor contributions (before the recency multiplier). */
	subtotal: number;
	/** the note's (LLM-inferred) topic slug, or null. */
	topic: string | null;
	rows: RecommendationBreakdownRow[];
	/** how the note was ranked: 'hand' (additive), 'learned' (pure model), or 'blend' (rank-fused). */
	mode?: 'hand' | 'learned' | 'blend';
	/** the learned ranker's value-weighted score Σ value · P(engagement), when a model was applied. */
	learnedScore?: number;
	/** the blend λ in effect (0 = pure hand-tuned, 1 = pure learned). */
	rankerWeight?: number;
	/** per-engagement predicted-probability rows of the learned ranker, when a model was applied. */
	engagements?: RecommendationEngagementRow[];
};

/** A recommended note may carry its ranking breakdown as a transient, underscore-prefixed field. */
export type NoteWithRecommendation = Misskey.entities.Note & { _recommendationFactors_?: RecommendationBreakdown };

/** Opens the breakdown table dialog for a recommended note. */
export function openRecommendationReason(breakdown: RecommendationBreakdown): void {
	const { dispose } = os.popup(defineAsyncComponent(() => import('@/components/MkRecommendationReason.vue')), {
		breakdown,
	}, {
		closed: () => dispose(),
	});
}
