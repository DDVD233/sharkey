/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiUser, NotesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { QueueService } from '@/core/QueueService.js';
import type { RecommendationSettings } from '@/core/rec-settings.js';
import type Logger from '@/logger.js';
import { RecBlocklistService } from './RecBlocklistService.js';
import { RecFollowsService } from './RecFollowsService.js';
import { RecInterestService } from './RecInterestService.js';
import { RecNoteFeaturesService } from './RecNoteFeaturesService.js';
import { RecRankingService } from './RecRankingService.js';
import { RecRetrievalService } from './RecRetrievalService.js';
import { REACTION_NORMAL_WEIGHT, ENGAGED_MAX, ANN_TOPK, ANN_EXCLUDE_CAP, AUTHOR_EXCLUDE_CAP, RETRIEVAL_QUALITY_MIN, QUEUE_MAX_STORE, QUEUE_TTL_SEC, CF_NEIGHBORS, CF_PER_NEIGHBOR_NOTES, CF_POOL_LIMIT, CF_TTL_SEC, CF_LOCK_TTL_SEC, SOCIAL_HISTORY_DAYS, SOCIAL_BASE_WEIGHT, SOCIAL_MAX_FOLLOWS, SOCIAL_FANOUT, SOCIAL_PER_FOLLOW_NOTES, SOCIAL_POOL_LIMIT, SOCIAL_TTL_SEC, SOCIAL_LOCK_TTL_SEC, CANDIDATE_FRESH_DAYS, NULL_LANG_WEIGHT, STRICT_LANG_MIN_AFFINITY, CONFIDENCE_K, type CandidateSource } from './constants.js';
import type { CandidateFeatures, ScoredCandidate } from './types.js';

@Injectable()
export class RecCandidateService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		@Inject(DI.config)
		private config: Config,
		private cacheService: CacheService,
		private idService: IdService,
		private milvusService: MilvusService,
		private queueService: QueueService,
		private recBlocklistService: RecBlocklistService,
		private recRetrievalService: RecRetrievalService,
		private recNoteFeaturesService: RecNoteFeaturesService,
		private recInterestService: RecInterestService,
		private recFollowsService: RecFollowsService,
		private recRankingService: RecRankingService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Rebuilds the user's candidate queue: unions content-ANN + popularity + still-unseen queued
	 * notes, removes already-pushed notes, filters for visibility/mutes/blocks/language, ranks, and
	 * rewrites `rec:queue:{userId}`. Returns the new queue length.
	 */
	/**
	 * Per-user, per-language queue key. The UI language is a client setting the server can't know
	 * except from the request, so the queue is keyed by the requested language: a user reading in
	 * `zh` and one reading in `en` get independent queues, and serving always matches the request.
	 */
	@bindThis
	public queueKey(userId: MiUser['id'], langs: string[]): string {
		// Key by the full (sorted) language set so changing the selection doesn't serve a stale queue.
		return `rec:queue:${userId}:${langs.length > 0 ? [...langs].sort().join('+') : 'all'}`;
	}

	@bindThis
	public async getFollowedSet(userId: MiUser['id']): Promise<Set<string>> {
		try {
			const followings = await this.cacheService.userFollowingsCache.fetch(userId);
			return new Set(followings.keys());
		} catch {
			return new Set();
		}
	}

	// --- collaborative-filtering retrieval (Tier B) ---

	/**
	 * Returns the cached collaborative-filtering candidate pool for a user as [{noteId, score}], and
	 * kicks off a background refresh if it's stale/missing. The serve path therefore NEVER blocks on the
	 * (Milvus user-ANN + neighbour fan-out) compute — it only ever reads one Redis zset, so 100 users
	 * building feeds at once cost 100 cheap reads, not 100 vector searches. A brand-new user's first feed
	 * has no CF slice; by the next refresh it's warm. The daily prebuild also pre-warms these.
	 */
	@bindThis
	private async getCfCandidates(userId: MiUser['id'], interest: { mm: number[] | null; txt: number[] | null }): Promise<{ noteId: string; score: number }[]> {
		const key = `rec:cf:${userId}`;
		let cached: string[] = [];
		try {
			cached = await this.redisForTimelines.zrevrange(key, 0, CF_POOL_LIMIT - 1, 'WITHSCORES');
		} catch { /* treat as empty */ }

		// Refresh when the pool is missing or its TTL has dropped below half — single-flighted by a lock
		// so concurrent feed builds for the same user don't stampede the compute. Fire-and-forget.
		try {
			const ttl = await this.redisForTimelines.ttl(key);
			const stale = ttl < 0 || ttl < CF_TTL_SEC / 2;
			if (stale && (interest.mm != null || interest.txt != null)) {
				const lock = await this.redisForTimelines.set(`rec:cf:lock:${userId}`, '1', 'EX', CF_LOCK_TTL_SEC, 'NX');
				if (lock === 'OK') this.computeCfCandidates(userId, interest).catch(() => { /* best-effort */ });
			}
		} catch { /* best-effort */ }

		const out: { noteId: string; score: number }[] = [];
		for (let i = 0; i + 1 < cached.length; i += 2) out.push({ noteId: cached[i], score: Number(cached[i + 1]) || 0 });
		return out;
	}

	/**
	 * Recomputes a user's CF pool: find taste-neighbours via user-vector ANN, gather the notes those
	 * neighbours recently engaged with, and score each candidate by Σ(neighbourSimilarity × engagement
	 * weight). The result is stored in `rec:cf:{userId}` (zset, TTL CF_TTL_SEC). Runs off the serve path.
	 */
	@bindThis
	private async computeCfCandidates(userId: MiUser['id'], interest: { mm: number[] | null; txt: number[] | null }): Promise<void> {
		try {
			// Neighbours from whichever modality vectors the user has; merge keeping the strongest similarity.
			const neighborSim = new Map<string, number>();
			const searches = await Promise.all([
				interest.mm ? this.milvusService.searchUsersByVector(interest.mm, CF_NEIGHBORS, 'mm') : Promise.resolve([]),
				interest.txt ? this.milvusService.searchUsersByVector(interest.txt, CF_NEIGHBORS, 'txt') : Promise.resolve([]),
			]);
			for (const hits of searches) {
				for (const h of hits) {
					if (h.userId === userId) continue; // never recommend off your own engagement
					const prev = neighborSim.get(h.userId);
					if (prev == null || h.score > prev) neighborSim.set(h.userId, h.score);
				}
			}
			if (neighborSim.size === 0) return;

			// Cap to the strongest neighbours and read each one's recent engagements in a single pipeline.
			const neighbors = [...neighborSim.entries()].sort((a, b) => b[1] - a[1]).slice(0, CF_NEIGHBORS);
			const pipe = this.redisForTimelines.pipeline();
			for (const [nid] of neighbors) pipe.lrange(`rec:engaged:${nid}`, 0, CF_PER_NEIGHBOR_NOTES - 1);
			const res = await pipe.exec();
			if (res == null) return;

			// Exclude notes the user has already engaged with (their own taste, not a discovery).
			const own = new Set((await this.redisForTimelines.lrange(`rec:engaged:${userId}`, 0, ENGAGED_MAX - 1))
				.map(e => e.slice(e.indexOf(':') + 1)));
			// Freshen: only notes recent enough to survive the recency gate are worth surfacing (older ones
			// would be crushed to ~0 regardless of the CF bonus). Lexical id compare (ids are time-ordered).
			const freshSinceId = this.idService.gen(Date.now() - CANDIDATE_FRESH_DAYS * 24 * 60 * 60 * 1000);

			// Aggregate: candidate score = Σ over neighbours who engaged it of (neighbourSim × engageWeight).
			const agg = new Map<string, number>();
			for (let i = 0; i < neighbors.length; i++) {
				const sim = Math.max(0, neighbors[i][1]);
				const entry = res[i];
				if (entry[0] != null) continue; // pipeline error for this neighbour
				const list = (entry[1] as string[] | null) ?? [];
				for (const e of list) {
					const idx = e.indexOf(':');
					const w = Number(e.slice(0, idx)) || REACTION_NORMAL_WEIGHT;
					const noteId = e.slice(idx + 1);
					if (own.has(noteId) || noteId < freshSinceId) continue;
					agg.set(noteId, (agg.get(noteId) ?? 0) + sim * w);
				}
			}
			if (agg.size === 0) return;

			const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, CF_POOL_LIMIT);
			const key = `rec:cf:${userId}`;
			const tx = this.redisForTimelines.multi().del(key);
			for (const [noteId, score] of top) tx.zadd(key, score, noteId);
			tx.expire(key, CF_TTL_SEC);
			await tx.exec();
			this.logger.info(`cf pool rebuilt for ${userId}: ${top.length} candidates from ${neighbors.length} neighbours`);
		} catch (err) {
			this.logger.warn(`computeCfCandidates failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// --- social-graph 2-hop retrieval (Twitter UTEG / GraphJet analog) ---

	/**
	 * Returns the cached social-graph 2-hop candidate pool ("notes people you follow engaged with") as
	 * [{noteId, score}], and kicks off a background refresh if it's stale/missing. Like {@link getCfCandidates}
	 * the serve path only ever reads one Redis zset; the (follow-graph fan-out + Postgres weighting) compute
	 * runs off-path, single-flighted. No-op for users who follow nobody.
	 */
	@bindThis
	private async getSocialCandidates(userId: MiUser['id'], followedSet: Set<string>): Promise<{ noteId: string; score: number }[]> {
		const key = `rec:social:${userId}`;
		let cached: string[] = [];
		try {
			cached = await this.redisForTimelines.zrevrange(key, 0, SOCIAL_POOL_LIMIT - 1, 'WITHSCORES');
		} catch { /* treat as empty */ }

		try {
			const ttl = await this.redisForTimelines.ttl(key);
			const stale = ttl < 0 || ttl < SOCIAL_TTL_SEC / 2;
			if (stale && followedSet.size > 0) {
				const lock = await this.redisForTimelines.set(`rec:social:lock:${userId}`, '1', 'EX', SOCIAL_LOCK_TTL_SEC, 'NX');
				if (lock === 'OK') this.computeSocialCandidates(userId, followedSet).catch(() => { /* best-effort */ });
			}
		} catch { /* best-effort */ }

		const out: { noteId: string; score: number }[] = [];
		for (let i = 0; i + 1 < cached.length; i += 2) out.push({ noteId: cached[i], score: Number(cached[i + 1]) || 0 });
		return out;
	}

	/**
	 * Recomputes a user's social-graph 2-hop pool (UTEG-style). Hop 1: the people the user follows, each
	 * weighted Real-Graph-lite by how much the user has actually engaged that account's notes over the last
	 * {@link SOCIAL_HISTORY_DAYS} (so accounts you interact with more carry more social proof; every follow
	 * still counts {@link SOCIAL_BASE_WEIGHT}). Hop 2: the {@link SOCIAL_FANOUT} top-weighted follows' recent
	 * engagements (their `rec:engaged` lists). A candidate's score = Σ over follows who engaged it of
	 * (followeeWeight × engageWeight). Stored in `rec:social:{userId}` (zset, TTL). Runs off the serve path.
	 */
	@bindThis
	private async computeSocialCandidates(userId: MiUser['id'], followedSet: Set<string>): Promise<void> {
		try {
			const followees = [...followedSet].slice(0, SOCIAL_MAX_FOLLOWS);
			if (followees.length === 0) return;

			// Real-Graph-lite weights: count the user's recent reactions / favourites / renotes / replies on
			// each followee's notes. weight = base + log1p(count) (dampened so a few heavy follows don't swamp).
			const sinceId = this.idService.gen(Date.now() - SOCIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000);
			const rows = await this.notesRepository.manager.query(`
				SELECT a.author AS author, count(*)::int AS c FROM (
					SELECT n."userId" AS author FROM note_reaction r JOIN note n ON n.id = r."noteId"
						WHERE r."userId" = $1 AND n."userId" = ANY($2) AND r.id > $3
					UNION ALL
					SELECT n."userId" FROM note_favorite f JOIN note n ON n.id = f."noteId"
						WHERE f."userId" = $1 AND n."userId" = ANY($2) AND f.id > $3
					UNION ALL
					SELECT t."userId" FROM note me JOIN note t ON t.id = me."renoteId"
						WHERE me."userId" = $1 AND t."userId" = ANY($2) AND me.id > $3
					UNION ALL
					SELECT t."userId" FROM note me JOIN note t ON t.id = me."replyId"
						WHERE me."userId" = $1 AND t."userId" = ANY($2) AND me.id > $3
				) a GROUP BY a.author`, [userId, followees, sinceId]) as { author: string; c: number }[];
			const engCount = new Map<string, number>();
			for (const r of rows) engCount.set(r.author, Number(r.c) || 0);
			const weightOf = (id: string): number => SOCIAL_BASE_WEIGHT + Math.log1p(engCount.get(id) ?? 0);

			// Expand hop 2 for only the top-weighted follows (UTEG's top-K first degree).
			const topFollows = followees.map(id => [id, weightOf(id)] as const).sort((a, b) => b[1] - a[1]).slice(0, SOCIAL_FANOUT);
			const pipe = this.redisForTimelines.pipeline();
			for (const [id] of topFollows) pipe.lrange(`rec:engaged:${id}`, 0, SOCIAL_PER_FOLLOW_NOTES - 1);
			const res = await pipe.exec();
			if (res == null) return;

			// Exclude notes the user has already engaged with (their own taste — incl. their own posts, which
			// are recorded as 'post' engagements — so self-authored notes never surface here).
			const own = new Set((await this.redisForTimelines.lrange(`rec:engaged:${userId}`, 0, ENGAGED_MAX - 1))
				.map(e => e.slice(e.indexOf(':') + 1)));
			// Freshen: only notes recent enough to survive the recency gate (a 3-week-old note your follow
			// liked today isn't good discovery, and the recency gate would crush it). Lexical id compare.
			const freshSinceId = this.idService.gen(Date.now() - CANDIDATE_FRESH_DAYS * 24 * 60 * 60 * 1000);

			// Aggregate: candidate score = Σ over follows who engaged it of (followeeWeight × engageWeight).
			const agg = new Map<string, number>();
			for (let i = 0; i < topFollows.length; i++) {
				const wF = topFollows[i][1];
				const entry = res[i];
				if (entry[0] != null) continue; // pipeline error for this followee
				const list = (entry[1] as string[] | null) ?? [];
				for (const e of list) {
					const idx = e.indexOf(':');
					const w = Number(e.slice(0, idx)) || REACTION_NORMAL_WEIGHT;
					const noteId = e.slice(idx + 1);
					if (own.has(noteId) || noteId < freshSinceId) continue;
					agg.set(noteId, (agg.get(noteId) ?? 0) + wF * w);
				}
			}
			if (agg.size === 0) return;

			const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, SOCIAL_POOL_LIMIT);
			const key = `rec:social:${userId}`;
			const tx = this.redisForTimelines.multi().del(key);
			for (const [noteId, score] of top) tx.zadd(key, score, noteId);
			tx.expire(key, SOCIAL_TTL_SEC);
			await tx.exec();
			this.logger.info(`social pool rebuilt for ${userId}: ${top.length} candidates from ${topFollows.length}/${followees.length} follows`);
		} catch (err) {
			this.logger.warn(`computeSocialCandidates failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Queue entries are JSON so they can carry the serve-time score breakdown (for impression logging). */
	@bindThis
	private serializeQueueEntry(c: ScoredCandidate): string {
		return JSON.stringify({ s: c.source, n: c.noteId, f: c.feat });
	}

	@bindThis
	public parseQueueEntry(entry: string): { source: CandidateSource; noteId: string; feat?: CandidateFeatures } | null {
		// Current format is JSON; tolerate the legacy `source:noteId` string for queues built pre-upgrade.
		if (entry.startsWith('{')) {
			try {
				const o = JSON.parse(entry) as { s: CandidateSource; n: unknown; f?: CandidateFeatures };
				if (typeof o.n === 'string') return { source: o.s, noteId: o.n, feat: o.f };
			} catch { /* fall through */ }
			return null;
		}
		const idx = entry.indexOf(':');
		if (idx < 0) return null;
		return { source: entry.slice(0, idx) as CandidateSource, noteId: entry.slice(idx + 1) };
	}

	@bindThis
	public async buildCandidateQueue(userId: MiUser['id'], langs: string[], settings: RecommendationSettings, withRenotes = true): Promise<number> {
		const key = this.queueKey(userId, langs);
		const excludeSensitive = !settings.recommendNsfw;
		// Whether the user explicitly chose their feed languages (then we stay strictly within `langs`) vs.
		// the default single-UI-language case (where we allow soft drift toward a strongly-engaged language).
		const restrictToSelected = settings.languages.length > 0;

		// [TIMING] temporary profiling — remove after diagnosing slow initial recommendation load.
		const __t0 = Date.now();
		let __tp = __t0;
		const __lap = (label: string): void => { const now = Date.now(); this.logger.info(`[timing] build ${label}: ${now - __tp}ms (cum ${now - __t0}ms)`); __tp = now; };

		const [{ weights: langWeights, total: langAffTotal }, followedSet, interest, muting, blockedUsers, recBlocked] = await Promise.all([
			this.recRetrievalService.getLangWeights(userId, langs, restrictToSelected),
			this.getFollowedSet(userId),
			this.recInterestService.getInterestVectors(userId),
			this.cacheService.userMutingsCache.fetch(userId),
			this.cacheService.userBlockedCache.fetch(userId),
			this.recBlocklistService.getBlockedAuthorIds(),
		]);
		// Authors to exclude AT RETRIEVAL (so they never take a top-K slot): the viewer's muted+blocked users
		// and the admin recommendation blocklist. Capped to keep the Milvus filter string bounded; the serve
		// path still re-applies these (covering the non-ANN sources + late mutes), so the cap is harmless.
		const excludeAuthorIds = [...new Set([...muting, ...blockedUsers, ...recBlocked])].slice(0, AUTHOR_EXCLUDE_CAP);
		__lap('prelude(langWeights+followed+interest+mutes)');
		const effectiveLangs = [...langWeights.keys()];
		const nullLangWeight = langAffTotal >= STRICT_LANG_MIN_AFFINITY ? 0 : NULL_LANG_WEIGHT;
		// Cold/warm gate: alpha rises from 0 (brand-new) toward 1 (veteran) with accumulated engagement.
		// At alpha≈0 the feed is quality+recency; at alpha→1 it's personal relevance.
		const alpha = langAffTotal / (langAffTotal + CONFIDENCE_K);

		// MULTI-SOURCE retrieval (Twitter-style candidate sources, blended into one ranking):
		//  • ANN (out-of-network content match) — the primary discovery source. A user without their own
		//    interest vector for a modality queries with the AVERAGE-user vector instead, so even a brand-new
		//    user gets a personalized-shaped feed. Each modality uses its own collection / query vector.
		//  • CF (out-of-network) — notes that taste-similar STRANGERS (interest-vector neighbours) engaged.
		//  • SOCIAL (out-of-network 2-hop, Twitter UTEG analog) — notes that people you FOLLOW engaged with.
		//    Both feed the `similarUsers` factor and are read from TTL-cached pools, so serving never blocks.
		// (In-network / followed posts themselves are NOT retrieved here — they come from the home-timeline
		// follows lane that's interleaved post-ranking; see buildFollowsLane / interleaveFollows below.)
		const [queryMm, queryTxt] = await Promise.all([
			interest.mm ?? this.recInterestService.getAverageUserVector('mm'),
			interest.txt ?? this.recInterestService.getAverageUserVector('txt'),
		]);
		// Exclude already-seen notes DURING ANN retrieval (most-recent first, capped) so the topK comes back
		// all-unseen instead of mostly-seen — otherwise we retrieve topK by similarity, discard the ~seen
		// half afterward, and are left only with the worse-similarity tail. The full pushed set is still
		// removed app-side below as a safety net for anything older than the cap.
		const pushedArr = await this.redisForTimelines.zrevrange(`rec:pushed:${userId}`, 0, -1);
		const seen = new Set(pushedArr);
		const excludeIds = pushedArr.slice(0, ANN_EXCLUDE_CAP);
		// Follows-lane ids (home-timeline, ≤FOLLOWED_RECENT_DAYS, unseen), fetched up-front: at
		// followedRatio ≥ 1 ("100% follows") the feed is follows-first and only falls back to discovery when
		// follows run out, so we can SKIP the expensive ANN+CF retrieval entirely when there are already
		// plenty of follows to fill the queue (with margin for post-scoring drop-off).
		// Resolve boosts in the follows lane: pure renotes become the note they boost (so they're scored on
		// real content and repeated boosts collapse), or are dropped when the user has boosts off.
		const followIds = await this.recFollowsService.resolveFollowRenotes(await this.recFollowsService.getFollowHomeIds(userId, seen), withRenotes);
		const skipDiscovery = settings.followedRatio >= 1 && followIds.length >= QUEUE_MAX_STORE * 2;
		const [annMm, annTxt, cfCands, socialCands, remaining] = await Promise.all([
			(!skipDiscovery && queryMm) ? this.milvusService.searchByVector(queryMm, ANN_TOPK, effectiveLangs, 'mm', excludeIds, excludeAuthorIds) : Promise.resolve([]),
			(!skipDiscovery && queryTxt) ? this.milvusService.searchByVector(queryTxt, ANN_TOPK, effectiveLangs, 'txt', excludeIds, excludeAuthorIds) : Promise.resolve([]),
			skipDiscovery ? Promise.resolve([] as { noteId: string; score: number }[]) : this.getCfCandidates(userId, interest),
			skipDiscovery ? Promise.resolve([] as { noteId: string; score: number }[]) : this.getSocialCandidates(userId, followedSet),
			this.redisForTimelines.lrange(key, 0, -1),
		]);
		__lap(`retrieval(ann mm=${annMm.length} txt=${annTxt.length}, cf=${cfCands.length}, social=${socialCands.length}, follows=${followIds.length}, skipDiscovery=${skipDiscovery}, excluded=${excludeIds.length})`);

		const candidates = new Map<string, ScoredCandidate>();
		const consider = (noteId: string, source: CandidateSource, annScore: number) => {
			const existing = candidates.get(noteId);
			if (existing == null) {
				candidates.set(noteId, { noteId, source, annScore });
			} else if (annScore > existing.annScore) {
				existing.annScore = annScore;
			}
		};
		// ANN first so a note that's both ANN-matched AND CF keeps source 'ann' (the real user↔note cosine);
		// the CF pass then only ADDS new notes. `followed`/`cfHit` are recomputed at rank time from the
		// sets/maps below, independent of which source first surfaced the note. (Followed authors' posts are
		// NOT mixed into this scored discovery pool — they come from a separate home-timeline follows lane,
		// interleaved post-ranking; see below.)
		for (const hit of annMm) consider(hit.noteId, 'ann', hit.score);
		for (const hit of annTxt) consider(hit.noteId, 'ann', hit.score);
		// CF candidates carry a taste-neighbour-weighted score; expose it via cfScores (drives `similarUsers`).
		const cfScores = new Map<string, number>();
		for (const { noteId, score } of cfCands) { consider(noteId, 'cf', 0); cfScores.set(noteId, score); }
		// FOLLOWS LANE (ids fetched above): add them to the SAME scored pool so every factor is computed
		// (a fresh follow gets recency≈1, real relevancy/author-affinity/quality — not zeros) and tagged
		// `fromFollows`; after ranking they're split back out and interleaved at the user's followedRatio.
		// Empty ⇒ pure discovery (the follows requirement is dropped, never stale-backfilled).
		for (const id of followIds) consider(id, 'following', 0);
		const followSet = new Set(followIds);
		// SOCIAL-GRAPH 2-HOP (UTEG-style): out-of-network notes that people you follow engaged with. Added
		// AFTER the follows lane so a followed author's own post keeps source 'following'; social only newly-
		// adds strangers' notes your network liked. Folded into cfScores too, so they earn the `similarUsers`
		// bonus (which now means "taste-neighbours OR your follows engaged this").
		for (const { noteId, score } of socialCands) {
			consider(noteId, 'social', 0);
			cfScores.set(noteId, Math.max(cfScores.get(noteId) ?? 0, score));
		}
		// Preserve still-unseen queued notes across rebuilds (refresh must not discard them). Carry their
		// last-known ANN score forward (from the stored feature snapshot) rather than resetting it to 0.
		for (const entry of remaining) {
			const parsed = this.parseQueueEntry(entry);
			if (parsed) consider(parsed.noteId, parsed.source, parsed.feat?.ann ?? 0);
		}

		// Remove already-pushed notes (safety net; the most-recent ANN_EXCLUDE_CAP were already excluded at
		// retrieval, this also covers any older ones beyond the cap). Follows were filtered against `seen`
		// when fetched, so this never drops them.
		for (const id of seen) candidates.delete(id);

		// HARD AGE CUTOFF: drop any candidate older than the Milvus retention window. ANN is already purged
		// to it, but the CF / social / carried-over (`remaining`) pools hold Redis note-ids of ANY age — without
		// this they leak ancient posts (recency-crushed to ~0 but still served once the fresh pool is exhausted,
		// e.g. 1000-day-old notes on page 1). Follows are already ≤FOLLOWED_RECENT_DAYS, so this never drops them.
		const minCandidateId = this.idService.gen(Date.now() - (this.config.recommendation?.vectorRetentionDays ?? 14) * 24 * 60 * 60 * 1000);
		for (const id of candidates.keys()) if (id < minCandidateId) candidates.delete(id);

		// One unified ranking over all candidates (quality drives the image:text mix; no fixed ratio).
		// `mmIds`/`features` are looked up once and shared with the ranker and the modality-floor pass.
		const candIds = [...candidates.keys()];
		__lap(`assemble(candidates=${candIds.length})`);
		const [mmIds, features, topics, topicInterest] = await Promise.all([
			this.recNoteFeaturesService.getMultimodalNoteIds(candIds),
			this.recNoteFeaturesService.getNoteFeatures(candIds),
			this.recNoteFeaturesService.getCandidateTopics(candIds),
			this.recInterestService.getTopicInterest(userId),
		]);
		// QUALITY GATE (post-Milvus, pre-rank): only quality-vetted notes are ever ranked/served. Drop
		// lowest-tier (q=1) candidates and not-yet-scored ones — the unscored are queued for scoring so they
		// become eligible once vetted. This is the quality floor the (removed) quality pool used to provide.
		let __qDropped = 0;
		for (const id of candIds) {
			if (followSet.has(id)) continue; // followed authors bypass the quality gate — you follow them, so their posts show regardless of quality (still enqueue scoring if unscored, below)
			const q = features.get(id)?.q ?? null;
			if (q == null) {
				this.queueService.createScoreNoteJob(id).catch(() => { /* best-effort */ });
				candidates.delete(id);
				__qDropped++;
			} else if (q < RETRIEVAL_QUALITY_MIN) {
				candidates.delete(id);
				__qDropped++;
			}
		}
		// Score any not-yet-scored follows in the background so their quality is known next time (they're
		// still served now — the gate above exempts them).
		for (const id of followIds) if (features.get(id)?.q == null) this.queueService.createScoreNoteJob(id).catch(() => { /* best-effort */ });
		// Real note↔interest cosine for the follows (so their relevancy factor isn't the neutral default) —
		// fetched straight from their stored vectors, since they may sit outside the ANN topK.
		const followSims = await this.recFollowsService.computeFollowSims(followIds, interest, mmIds);
		// Overlay the user's explicit interest/disinterest topics on top of the auto-derived array; an
		// explicit pick (+1 interested / −1 not-interested) wins over the engagement-derived value.
		for (const t of settings.interestTopics) topicInterest[t] = 1;
		for (const t of settings.disinterestTopics) topicInterest[t] = -1;
		__lap(`mmIds+features+topics (qualityGate dropped ${__qDropped})`);
		const ranked = await this.recRankingService.rankCandidates(userId, [...candidates.values()], langWeights, followedSet, nullLangWeight, excludeSensitive, settings.factors, alpha, mmIds, features, interest, cfScores, topics, topicInterest, followSet, followSims);
		__lap(`rankCandidates(ranked=${ranked.length})`);
		// Split the scored output into the follows lane (home-timeline followed posts, score-ranked among
		// themselves) and discovery, then interleave follows at the user's followedRatio. Both sides keep
		// their score order; nothing is dropped. Empty follows ⇒ pure discovery.
		const followsRanked = ranked.filter(c => c.feat?.fromFollows === true);
		const discoveryRanked = ranked.filter(c => c.feat?.fromFollows !== true);
		const ordered = this.recFollowsService.interleaveFollows(discoveryRanked, followsRanked, settings.followedRatio);
		__lap(`interleaveFollows(discovery=${discoveryRanked.length}, follows=${followsRanked.length}, ratio=${settings.followedRatio})`);

		// Persist only the top slice — the rest is never served before the next rebuild re-retrieves fresh.
		const toStore = ordered.slice(0, QUEUE_MAX_STORE);
		const tx = this.redisForTimelines.multi().del(key);
		if (toStore.length > 0) {
			tx.rpush(key, ...toStore.map(c => this.serializeQueueEntry(c)));
			tx.expire(key, QUEUE_TTL_SEC);
		}
		await tx.exec();
		__lap('redis-write');
		return toStore.length;
	}
}
