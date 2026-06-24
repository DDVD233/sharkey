/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import type { MiNote, MiUser } from '@/models/_.js';
import type { Modality } from '@/core/MilvusService.js';
import type { RecommendationSettings } from '@/core/rec-settings.js';
import type { Topic } from '@/core/rec-topics.js';
import { RecBackfillService } from './recommendation/RecBackfillService.js';
import { RecBlocklistService } from './recommendation/RecBlocklistService.js';
import { RecCandidateService } from './recommendation/RecCandidateService.js';
import { RecFollowsService } from './recommendation/RecFollowsService.js';
import { RecInterestService } from './recommendation/RecInterestService.js';
import { RecNoteFeaturesService } from './recommendation/RecNoteFeaturesService.js';
import { RecRankingService } from './recommendation/RecRankingService.js';
import { RecRetrievalService } from './recommendation/RecRetrievalService.js';
import { RecServingService } from './recommendation/RecServingService.js';
import { normalizeLang } from './recommendation/lang.js';
import type { EngagementKind } from './recommendation/constants.js';
import type { RecommendationPage } from './recommendation/types.js';

export type { CandidateSource, EngagementKind } from './recommendation/constants.js';
export type { RecommendationBreakdownRow, RecommendationEngagementRow, RecommendationBreakdown, RecommendationPage } from './recommendation/types.js';

/**
 * Orchestrates the personalized recommendation feed: builds per-user interest vectors, generates
 * and ranks candidate notes (content ANN + popularity), maintains a per-user Redis candidate queue,
 * deduplicates already-pushed notes, and logs impressions. All vector/ANN work is best-effort — if
 * Milvus/embeddings are unavailable the feed degrades to popularity.
 *
 * Redis keys (on the timelines instance):
 *  - rec:queue:{userId}    list   ordered `${source}:${noteId}`, best-first; popped as served
 *  - rec:pushed:{userId}   zset   member=noteId score=pushedAt(ms); source of truth for dedup
 *  - rec:engaged:{userId}  list   recent `${kind}:${noteId}` positive engagements (most recent first)
 *  - rec:uvec:{userId}     string cached JSON interest vector
 *  - rec:dirty:{userId}    string set when the interest vector needs recompute
 */
@Injectable()
export class RecommendationService {
	constructor(
		private recBlocklistService: RecBlocklistService,
		private recRetrievalService: RecRetrievalService,
		private recNoteFeaturesService: RecNoteFeaturesService,
		private recInterestService: RecInterestService,
		private recFollowsService: RecFollowsService,
		private recRankingService: RecRankingService,
		private recCandidateService: RecCandidateService,
		private recServingService: RecServingService,
		private recBackfillService: RecBackfillService,
	) {
	}

	@bindThis
	public async getBlockedAuthorIds(): Promise<Set<string>> {
		return this.recBlocklistService.getBlockedAuthorIds();
	}

	@bindThis
	public async isAuthorBlocked(userId: MiUser['id']): Promise<boolean> {
		return this.recBlocklistService.isAuthorBlocked(userId);
	}

	@bindThis
	public async purgeBlockedUsers(): Promise<{ users: number; notesScanned: number; hqRemoved: number; featRemoved: number }> {
		return this.recBlocklistService.purgeBlockedUsers();
	}

	@bindThis
	public async resolveLangs(userId: MiUser['id'] | null, requestedLang?: string | null): Promise<string[]> {
		return this.recServingService.resolveLangs(userId, requestedLang);
	}

	@bindThis
	public normalizeLang(lang: string | null | undefined): string | null {
		return normalizeLang(lang);
	}

	@bindThis
	public async onPositiveEngagement(userId: MiUser['id'], note: Pick<MiNote, 'id' | 'lang'>, kind: EngagementKind, opts?: { reaction?: string }): Promise<void> {
		return this.recInterestService.onPositiveEngagement(userId, note, kind, opts);
	}

	@bindThis
	public async markNotInterested(userId: MiUser['id'], noteId: string): Promise<void> {
		return this.recInterestService.markNotInterested(userId, noteId);
	}

	@bindThis
	public async onReplyEngagedByAuthor(viewerId: MiUser['id'], recommendedNoteId: string): Promise<void> {
		return this.recInterestService.onReplyEngagedByAuthor(viewerId, recommendedNoteId);
	}

	@bindThis
	public async recordDwell(userId: MiUser['id'], items: { noteId: string; dwellMs: number }[]): Promise<void> {
		return this.recInterestService.recordDwell(userId, items);
	}

	@bindThis
	public async foldAuthorCentroid(authorId: MiUser['id'], modality: Modality, vector: number[]): Promise<void> {
		return this.recInterestService.foldAuthorCentroid(authorId, modality, vector);
	}

	@bindThis
	public async backfillAuthorCentroids(sinceDays = 70): Promise<{ authors: number; computed: number }> {
		return this.recInterestService.backfillAuthorCentroids(sinceDays);
	}

	@bindThis
	public async recomputeInterestVectors(userId: MiUser['id']): Promise<{ mm: number[] | null; txt: number[] | null }> {
		return this.recInterestService.recomputeInterestVectors(userId);
	}

	@bindThis
	public async recomputeAllUserVectors(): Promise<number> {
		return this.recInterestService.recomputeAllUserVectors();
	}

	@bindThis
	public async prefillRecent(days: number, limit: number, langs?: string[], imagesOnly = false): Promise<number> {
		return this.recBackfillService.prefillRecent(days, limit, langs, imagesOnly);
	}

	@bindThis
	public async backfillQuality(days: number, limit: number, langs?: string[]): Promise<number> {
		return this.recBackfillService.backfillQuality(days, limit, langs);
	}

	@bindThis
	public async backfillTopics(days: number, limit: number, langs?: string[]): Promise<number> {
		return this.recBackfillService.backfillTopics(days, limit, langs);
	}

	@bindThis
	public async backfillUserFromHistory(userId: MiUser['id']): Promise<number> {
		return this.recBackfillService.backfillUserFromHistory(userId);
	}

	@bindThis
	public async backfillAllUsersFromHistory(): Promise<number> {
		return this.recBackfillService.backfillAllUsersFromHistory();
	}

	@bindThis
	public async recordNoteFeatures(noteId: MiNote['id'], text: string | null, imageDataUrls: string[], lang?: string | null): Promise<void> {
		return this.recNoteFeaturesService.recordNoteFeatures(noteId, text, imageDataUrls, lang);
	}

	@bindThis
	public async backfillHighQualityIndex(days: number, limit: number, langs?: string[]): Promise<number> {
		return this.recNoteFeaturesService.backfillHighQualityIndex(days, limit, langs);
	}

	@bindThis
	public async isBelowRetrievalQuality(noteId: MiNote['id']): Promise<boolean> {
		return this.recNoteFeaturesService.isBelowRetrievalQuality(noteId);
	}

	@bindThis
	public async buildCandidateQueue(userId: MiUser['id'], langs: string[], settings: RecommendationSettings, withRenotes = true): Promise<number> {
		return this.recCandidateService.buildCandidateQueue(userId, langs, settings, withRenotes);
	}

	@bindThis
	public async getUserTopicInterest(userId: MiUser['id']): Promise<{ interested: Topic[]; disinterested: Topic[] }> {
		return this.recInterestService.getUserTopicInterest(userId);
	}

	@bindThis
	public async recordHomeTimelineViews(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		return this.recFollowsService.recordHomeTimelineViews(userId, noteIds);
	}

	@bindThis
	public async getPage(userId: MiUser['id'] | null, langs: string[], limit: number, refresh: boolean, offset: number, excludeSensitiveAnon = true, withRenotes = true): Promise<RecommendationPage> {
		return this.recServingService.getPage(userId, langs, limit, refresh, offset, excludeSensitiveAnon, withRenotes);
	}
}
