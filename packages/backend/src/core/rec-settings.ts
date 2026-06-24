/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TOPIC_LABELS } from '@/core/rec-topics.js';

/**
 * Per-user recommendation settings. Every value is a *multiplier on top of* the global scoring
 * constants in {@link RecommendationService} (e.g. global quality 0.9 × user 2 = 1.8) — they never
 * replace or renormalize the defaults. Stored as a (nullable) JSON column on the user profile and read
 * back at rank time; a null/partial column always resolves to {@link DEFAULT_REC_SETTINGS} via
 * {@link mergeRecSettings}, so missing fields are the identity (coefficient 1, no behavioural change).
 */

/** Ranking-factor coefficients. Each is a 0..2 multiplier (0 = ignore the factor, 1 = unchanged, 2 = doubled). */
export const REC_FACTOR_KEYS = [
	'relevancy', 'authorAffinity', 'quality', 'popularity',
	'recency', 'shortPostPenalty', 'overTagPenalty', 'replyPenalty',
	'topicPreference', 'followed', 'similarUsers',
] as const;
export type RecFactorKey = typeof REC_FACTOR_KEYS[number];

/** Interest-vector update weights, one per engagement kind. Each is a 0..2 multiplier on the base signal weight. */
export const REC_ENGAGEMENT_KEYS = ['reaction', 'reply', 'boost', 'favorite', 'post'] as const;
export type RecEngagementKey = typeof REC_ENGAGEMENT_KEYS[number];

/** Languages the recommender has data (Milvus collections) for — the only ones a user may pick. */
export const REC_LANGUAGES = ['en', 'ja', 'zh'] as const;
export type RecLanguage = typeof REC_LANGUAGES[number];

export type RecommendationSettings = {
	enabled: boolean;
	recommendNsfw: boolean;
	factors: Record<RecFactorKey, number>;
	engagement: Record<RecEngagementKey, number>;
	interestTopics: string[];
	disinterestTopics: string[];
	/** Languages to recommend in. Empty = fall back to the user's UI language (current default behaviour). */
	languages: string[];
	/** Share of feed slots (0..1) filled from your home timeline (latest posts from accounts you follow,
	 * ≤7 days old, unseen), interleaved into the score-ranked discovery feed. 0 = discovery only; 1 = all
	 * follows first, discovery only as a fallback once follows run out. */
	followedRatio: number;
};

/** A loosely-typed, deeply-partial settings object as it arrives from the DB column or the API param. */
export type PartialRecommendationSettings = {
	enabled?: boolean;
	recommendNsfw?: boolean;
	factors?: Partial<Record<RecFactorKey, number>>;
	engagement?: Partial<Record<RecEngagementKey, number>>;
	interestTopics?: readonly string[];
	disinterestTopics?: readonly string[];
	languages?: readonly string[];
	followedRatio?: number;
};

function unitFactors(): Record<RecFactorKey, number> {
	return Object.fromEntries(REC_FACTOR_KEYS.map(k => [k, 1])) as Record<RecFactorKey, number>;
}

function unitEngagement(): Record<RecEngagementKey, number> {
	return Object.fromEntries(REC_ENGAGEMENT_KEYS.map(k => [k, 1])) as Record<RecEngagementKey, number>;
}

export const DEFAULT_REC_SETTINGS: RecommendationSettings = {
	enabled: true,
	recommendNsfw: false,
	factors: unitFactors(),
	engagement: unitEngagement(),
	interestTopics: [],
	disinterestTopics: [],
	languages: [],
	followedRatio: 0.3,
};

const clamp02 = (x: number): number => Math.max(0, Math.min(2, x));
const clampRatio = (x: number): number => Math.max(0, Math.min(1, x));
const isTopic = (t: unknown): t is string => typeof t === 'string' && (TOPIC_LABELS as readonly string[]).includes(t);
const isLanguage = (t: unknown): t is string => typeof t === 'string' && (REC_LANGUAGES as readonly string[]).includes(t);

/**
 * Resolves a possibly-null/partial stored settings object into a fully-populated, sanitized one:
 * coefficients are clamped to [0,2], topic lists are filtered to the known taxonomy and made disjoint
 * (interest wins on conflict), and anything missing falls back to the identity default. Safe to feed raw
 * DB/JSON input — used both at rank time and (as a normalizer) on the write path.
 */
export function mergeRecSettings(partial: PartialRecommendationSettings | null | undefined): RecommendationSettings {
	const p = partial ?? {};

	const factors = unitFactors();
	for (const k of REC_FACTOR_KEYS) {
		const v = p.factors?.[k];
		if (typeof v === 'number' && Number.isFinite(v)) factors[k] = clamp02(v);
	}
	const engagement = unitEngagement();
	for (const k of REC_ENGAGEMENT_KEYS) {
		const v = p.engagement?.[k];
		if (typeof v === 'number' && Number.isFinite(v)) engagement[k] = clamp02(v);
	}

	const interest = Array.isArray(p.interestTopics) ? [...new Set(p.interestTopics.filter(isTopic))] : [];
	const interestSet = new Set(interest);
	const disinterest = Array.isArray(p.disinterestTopics)
		? [...new Set(p.disinterestTopics.filter(isTopic))].filter(t => !interestSet.has(t)) // disjoint; interest wins
		: [];
	const languages = Array.isArray(p.languages) ? [...new Set(p.languages.filter(isLanguage))] : [];

	return {
		enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_REC_SETTINGS.enabled,
		recommendNsfw: typeof p.recommendNsfw === 'boolean' ? p.recommendNsfw : DEFAULT_REC_SETTINGS.recommendNsfw,
		factors,
		engagement,
		interestTopics: interest,
		disinterestTopics: disinterest,
		languages,
		followedRatio: (typeof p.followedRatio === 'number' && Number.isFinite(p.followedRatio))
			? clampRatio(p.followedRatio) : DEFAULT_REC_SETTINGS.followedRatio,
	};
}
