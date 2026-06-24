/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, MiUser, NoteRecommendationImpressionsRepository, UserProfilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import type Logger from '@/logger.js';
import { RecCandidateService } from './RecCandidateService.js';
import { RecInterestService } from './RecInterestService.js';
import { RecRankingService } from './RecRankingService.js';
import { RecRetrievalService } from './RecRetrievalService.js';
import { ANN_TOPK, QUEUE_LOW_WATERMARK, PUSHED_TTL_SEC, type CandidateSource } from './constants.js';
import { normalizeLang } from './lang.js';
import type { CandidateFeatures, RecommendationBreakdown, RecommendationPage } from './types.js';

@Injectable()
export class RecServingService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.noteRecommendationImpressionsRepository)
		private noteRecommendationImpressionsRepository: NoteRecommendationImpressionsRepository,
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,
		@Inject(DI.config)
		private config: Config,
		private idService: IdService,
		private milvusService: MilvusService,
		private recRetrievalService: RecRetrievalService,
		private recInterestService: RecInterestService,
		private recRankingService: RecRankingService,
		private recCandidateService: RecCandidateService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Returns the next page of recommended notes.
	 * - Logged-in: pops from the per-user candidate queue (lazily (re)building it when empty/low or
	 *   when `refresh` is set), logs impressions, and never repeats already-pushed notes.
	 * - Anonymous (userId null): serves global-popular + recent matched-language notes by `offset`,
	 *   with no impression logging.
	 */
	@bindThis
	public async getPage(userId: MiUser['id'] | null, langs: string[], limit: number, refresh: boolean, offset: number, excludeSensitiveAnon = true, withRenotes = true): Promise<RecommendationPage> {
		const __pg0 = Date.now();
		if (userId == null) {
			return { notes: await this.getAnonymousPage(langs, limit, offset, excludeSensitiveAnon, !withRenotes), breakdowns: new Map() };
		}

		// Per-user recommendation settings (factors, NSFW, enable, topic overrides) — read once per page.
		const settings = await this.recInterestService.getEffectiveRecSettings(userId);
		// Feature switched off entirely: serve nothing (the client also hides the feed/tabs).
		if (!settings.enabled) return { notes: [], breakdowns: new Map() };
		const excludeSensitive = !settings.recommendNsfw;

		const key = this.recCandidateService.queueKey(userId, langs);
		const len = await this.redisForTimelines.llen(key);
		// The algorithm runs on request, using the language the client sent (the server has no other
		// reliable source for the UI language). We rebuild on each feed-open (offset 0) — cheap for
		// rarely-online users since nothing runs unless they ask, and fresh for new users whose
		// interest shifts fast — or when the queue is low / the user explicitly refreshed. Load-more
		// (offset > 0) just pages the existing queue. Rebuild preserves still-unseen queued notes and
		// excludes already-pushed ones, so a refresh never repeats or discards unseen content.
		const isFreshLoad = offset === 0;
		const __builtNow = refresh || isFreshLoad || len < QUEUE_LOW_WATERMARK;
		if (__builtNow) {
			const __b0 = Date.now();
			await this.recCandidateService.buildCandidateQueue(userId, langs, settings, withRenotes);
			this.logger.info(`[timing] getPage buildCandidateQueue: ${Date.now() - __b0}ms`);
		}

		const popped = await this.redisForTimelines.lpop(key, limit);
		const entries = popped ?? [];

		const order: string[] = [];
		const sourceOf = new Map<string, CandidateSource>();
		const featOf = new Map<string, CandidateFeatures>();
		for (const entry of entries) {
			const parsed = this.recCandidateService.parseQueueEntry(entry);
			if (parsed == null) continue;
			order.push(parsed.noteId);
			sourceOf.set(parsed.noteId, parsed.source);
			if (parsed.feat) featOf.set(parsed.noteId, parsed.feat);
		}

		// If the queue couldn't fill the page, top up directly from the recent tail so the feed
		// never dead-ends mid-scroll.
		if (order.length < limit) {
			const pushed = await this.redisForTimelines.zrange(`rec:pushed:${userId}`, 0, -1);
			const exclude = [...pushed, ...order];
			const tail = await this.recRetrievalService.getRecentLangTail(userId, langs, exclude, limit - order.length);
			for (const id of tail) {
				order.push(id);
				sourceOf.set(id, 'fallback');
			}
		}

		const __l0 = Date.now();
		const notes = await this.recRetrievalService.loadAndFilterNotes(order, userId, excludeSensitive, !withRenotes);
		const ordered = this.recRetrievalService.reorder(notes, order);
		this.logger.info(`[timing] getPage page-load(${order.length}): ${Date.now() - __l0}ms; getPage total (built=${__builtNow}): ${Date.now() - __pg0}ms`);

		if (ordered.length > 0) {
			// `rank` is the position in the served page — a key feature/position-bias signal for training.
			await this.recordImpressions(userId, ordered.map((n, rank) => ({
				noteId: n.id,
				source: sourceOf.get(n.id) ?? 'fallback',
				rank,
				feat: featOf.get(n.id),
			})));
		}

		// Per-note "why recommended?" breakdown, reconstructed from the stored score features (no re-rank).
		const breakdowns = new Map<string, RecommendationBreakdown>();
		for (const n of ordered) {
			const f = featOf.get(n.id);
			if (f) breakdowns.set(n.id, this.recRankingService.buildBreakdown(f));
		}
		return { notes: ordered, breakdowns };
	}

	@bindThis
	private async getAnonymousPage(langs: string[], limit: number, offset: number, excludeSensitive: boolean, excludeRenotes = false): Promise<MiNote[]> {
		// Anonymous discovery: pure ANN using the AVERAGE-user vector ("what a typical user likes"), so even
		// logged-out users get a taste-shaped feed rather than the old quality/news pool. Best-ANN-score
		// order; only falls back to the recent matched-language tail if no average vector exists yet.
		const effLangs = langs.map(l => normalizeLang(l)).filter((l): l is string => l != null);
		const [avgMm, avgTxt] = await Promise.all([this.recInterestService.getAverageUserVector('mm'), this.recInterestService.getAverageUserVector('txt')]);
		const [annMm, annTxt] = await Promise.all([
			avgMm ? this.milvusService.searchByVector(avgMm, ANN_TOPK, effLangs, 'mm') : Promise.resolve([]),
			avgTxt ? this.milvusService.searchByVector(avgTxt, ANN_TOPK, effLangs, 'txt') : Promise.resolve([]),
		]);
		const byId = new Map<string, number>();
		for (const h of [...annMm, ...annTxt]) byId.set(h.noteId, Math.max(byId.get(h.noteId) ?? 0, h.score));
		const ids = [...byId.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 500);
		const notes = this.recRetrievalService.reorder(await this.recRetrievalService.loadAndFilterNotes(ids, null, excludeSensitive, excludeRenotes), ids);

		let page = notes.slice(offset, offset + limit);
		if (page.length < limit) {
			// Last-resort backfill from the recent matched-language tail (e.g. before any user vectors exist).
			const exclude = notes.map(n => n.id);
			const tailIds = await this.recRetrievalService.getRecentLangTail(null, langs, exclude, (offset + limit) - notes.length);
			const tailNotes = this.recRetrievalService.reorder(await this.recRetrievalService.loadAndFilterNotes(tailIds, null, excludeSensitive, excludeRenotes), tailIds);
			page = [...notes, ...tailNotes].slice(offset, offset + limit);
		}
		return page;
	}

	@bindThis
	private async recordImpressions(userId: MiUser['id'], items: { noteId: string; source: CandidateSource; rank: number; feat?: CandidateFeatures }[]): Promise<void> {
		if (items.length === 0) return;
		const now = Date.now();

		// Redis dedup set (source of truth for "don't repeat").
		try {
			const key = `rec:pushed:${userId}`;
			const tx = this.redisForTimelines.multi();
			for (const it of items) {
				tx.zadd(key, now, it.noteId);
			}
			tx.zremrangebyscore(key, '-inf', now - PUSHED_TTL_SEC * 1000);
			tx.expire(key, PUSHED_TTL_SEC);
			await tx.exec();
		} catch (err) {
			this.logger.warn(`recordImpressions (redis) failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// SQL impression log (training data), fire-and-forget. Each row snapshots the serve-time score
		// breakdown so a ranker can later be trained on (features → did the user engage). Wrapped so
		// neither a synchronous throw (e.g. missing table/metadata) nor a rejection can break serving.
		try {
			const pushedAt = new Date(now);
			this.noteRecommendationImpressionsRepository.insert(items.map(it => ({
				id: this.idService.gen(now),
				userId,
				noteId: it.noteId,
				pushedAt,
				source: it.source,
				rank: it.rank,
				annScore: it.feat?.ann ?? null,
				authorScore: it.feat?.authorSim ?? null,
				cfScore: it.feat?.cfScore ?? null,
				qualityScore: it.feat?.quality ?? null,
				recencyScore: it.feat?.recency ?? null,
				langWeight: it.feat?.langW ?? null,
				alpha: it.feat?.alpha ?? null,
				score: it.feat?.score ?? null,
				followed: it.feat?.followed ?? null,
				isMultimodal: it.feat?.mm ?? null,
				// Extended feature snapshot — the full heavy-ranker feature vector (for training a future model).
				popularityScore: it.feat?.engagement ?? null,
				shortnessSignal: it.feat?.shortness ?? null,
				overTagSignal: it.feat?.overTag ?? null,
				isReplySignal: it.feat != null ? (it.feat.isReply ? true : false) : null,
				topicInterest: it.feat?.topicV ?? null,
				cfHit: it.feat?.cfHit ?? null,
				learnedScore: it.feat?.learnedScore ?? null,
				dwellMs: null, // filled in later by the dwell-reporting endpoint
			}))).catch(err => {
				this.logger.warn(`recordImpressions (sql) failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		} catch (err) {
			this.logger.warn(`recordImpressions (sql) threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Resolves the language set used to filter a user's feed. We recommend only in the user's own
	 * language: the request-supplied UI locale wins, then the stored profile language, then the
	 * instance default. zh-CN/zh-TW collapse to zh via {@link normalizeLang}.
	 */
	@bindThis
	public async resolveLangs(userId: MiUser['id'] | null, requestedLang?: string | null): Promise<string[]> {
		// An explicit per-user language selection wins: the feed is retrieved across ALL chosen languages
		// and ranked together. Empty selection → fall back to the request/profile UI language (the default).
		if (userId != null) {
			const settings = await this.recInterestService.getEffectiveRecSettings(userId);
			const picked = [...new Set(settings.languages.map(l => normalizeLang(l)).filter((l): l is string => l != null))];
			if (picked.length > 0) return picked;
		}

		const fromRequest = normalizeLang(requestedLang);
		if (fromRequest) return [fromRequest];

		if (userId) {
			const profile = await this.userProfilesRepository.findOneBy({ userId });
			const fromProfile = normalizeLang(profile?.lang);
			if (fromProfile) return [fromProfile];
		}

		const fallback = this.config.recommendation?.supportedLangs?.[0] ?? 'en';
		return [normalizeLang(fallback) ?? 'en'];
	}
}
