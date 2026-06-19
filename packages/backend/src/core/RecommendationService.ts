/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, MiUser, NotesRepository, NoteRecommendationImpressionsRepository, UserProfilesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService, type Modality } from '@/core/MilvusService.js';
import { LlmQualityService } from '@/core/LlmQualityService.js';
import { QueueService } from '@/core/QueueService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { analyzeNoteText, structuralQuality } from '@/misc/note-quality.js';
import type Logger from '@/logger.js';

export type CandidateSource = 'ann' | 'perUser' | 'global' | 'following' | 'fallback';

export type EngagementKind = 'reaction' | 'renote' | 'reply' | 'favorite' | 'post';

/**
 * Relative strength of each positive signal when building the interest vector.
 * Reply > Boost(renote) > rare(custom) reaction > normal reaction. A bookmark/favorite is an
 * intentional save, weighted alongside a boost. (Notes shown but not engaged with are implicit
 * negatives — captured in the impression log for future ranker training, not here.)
 */
const REPLY_WEIGHT = 3;
const RENOTE_WEIGHT = 2;
const FAVORITE_WEIGHT = 2;
const POST_WEIGHT = 2; // the user's own original posts express their interests
const REACTION_RARE_WEIGHT = 1.5;
const REACTION_NORMAL_WEIGHT = 1;

// Tunables for candidate generation / ranking.
const ENGAGED_MAX = 200; // how many recent engagements feed the interest vector
const ANN_TOPK = 400;
const FEATURED_THRESHOLD = 100;
const QUEUE_LOW_WATERMARK = 12;
const QUEUE_TTL_SEC = 60 * 60 * 24; // queues are cheap to rebuild; expire after a day of inactivity
const PUSHED_TTL_SEC = 60 * 60 * 24 * 30; // "don't repeat" window
const RECENCY_HALF_LIFE_HOURS = 36;
// Implicit negatives (notes shown but not engaged) are treated as VERY soft negatives via Rocchio:
// the user may simply not have bothered to react. A small coefficient nudges away from skipped
// content without ever overpowering an actual like.
const SOFT_NEGATIVE_WEIGHT = 0.15;
const NEG_SAMPLE_MAX = 100;
// Online interest vector: each like nudges the stored vector toward the liked note via an
// exponential moving average (real-time, O(dim), no history cap). Stronger signals move it more.
const EMA_ALPHA = 0.2;

// Flat bonus added when a candidate's author is someone the user follows — so followed people's
// posts surface near the top, even across languages, without drowning out discovery.
const W_FOLLOW = 0.3;

// Soft language preference. The user's chosen language always carries at least BASE_SELECTED_LANG
// weight; other languages earn weight in proportion to how much the user actually likes them, so a
// "selected zh but always likes ja" user sees more ja over time and the language filter softens.
const BASE_SELECTED_LANG = 0.7;
const NULL_LANG_WEIGHT = 0.2; // unknown-language notes: low-priority filler (cold users only)
// Cross-language weighting is a smooth, conservative curve (no hard cutoff): a non-selected language
// only earns meaningful weight when it both dominates the user's likes (logistic in share, centred
// at ~90%) AND there's enough signal to be significant (sample confidence ~total/(total+K)). Below
// that it tapers continuously toward zero.
const CROSS_LANG_SHARE_MIDPOINT = 0.9;
const CROSS_LANG_SHARE_TEMP = 0.05;
const CROSS_LANG_SAMPLE_K = 1000;

// Image (multimodal) and text-only embeddings live in different vector subspaces and are matched
// separately (two Milvus collections). The image:text MIX of the feed is no longer a fixed per-user
// ratio — it's driven by post quality in one unified ranking, bounded only by MODALITY_FLOOR below.
// Once a user has this much engagement signal, we trust their language(s) and stop mixing in
// undetected-language notes — which are frequently NOT in their language and read as noise.
const STRICT_LANG_MIN_AFFINITY = 5;

// Diversity: cap how many notes from a single author can sit in the top of the queue, so a heavily
// followed/prolific account can't fill the feed (overflow is demoted, not dropped).
const MAX_PER_AUTHOR = 3;

// Follow-graph as a candidate source / interest seed.
const FOLLOWED_CANDIDATE_LIMIT = 150;
const FOLLOWED_RECENT_DAYS = 7;
const FOLLOW_SEED_MAX = 100; // followed-author posts used to seed an old user's initial vector
const FOLLOW_SEED_WEIGHT = 0.5;

// --- Quality-prior & cold/warm blend -----------------------------------------------------------
// Per-note features (quality, structure) are computed once off the hot path and cached here. They
// outlive the 60-day vector window slightly so a note is never ranked without its features.
const FEATURE_TTL_SEC = 60 * 60 * 24 * 65;
// The whole ranking collapses to: score = α·relevance + (1−α)·qualityPrior, with α = n/(n+CONFIDENCE_K).
// `n` is the user's accumulated engagement signal. A brand-new user (n≈0) is served almost purely on
// quality + freshness (no personal signal to trust yet); a veteran (n≫K) almost purely on personal
// relevance ("catch up with friends / things I like"). One interpretable knob replaces the old
// cold-start branches. K ≈ the engagement mass at which personalization reaches half weight.
const CONFIDENCE_K = 20;
// …but quality/recency/popularity are intrinsic, not cold-start crutches, so they must never fully
// disappear for veterans. We floor the quality-prior weight (equivalently, cap the gate at
// α ≤ 1−QUALITY_PRIOR_FLOOR). With 0.5, relevance is hard-capped at 50% for established users and the
// prior keeps ≥50%; combined with the QP split below, a maxed-out veteran sits at exactly
// relevance 50% / quality 25% / recency 20% / popularity 5%. New users keep their tiny α (the cap
// doesn't bind), so their relevance share is far lower and quality/recency dominate.
const QUALITY_PRIOR_FLOOR = 0.5;
// qualityPrior = weighted blend of content quality (LLM interestingness / structural fallback),
// freshness and popularity. Weights sum to 1; at the veteran cap (prior weight 0.5) these become the
// floors quality 25% / recency 20% / popularity 5% of the total score. Recency is strong so a new
// user never sees month-old posts on the first page.
const QP_QUALITY = 0.5;
const QP_RECENCY = 0.4;
const QP_ENGAGEMENT = 0.1;
// Map the 1-5 LLM interestingness score into [0.2,1] (a "1" is poor, not worthless).
const llmTo01 = (q: number): number => Math.max(0, Math.min(1, q / 5));
// Global policy: image posts tend to be more engaging to a general audience, so they get a small flat
// lift. The image:text mix is otherwise driven by the quality of the post pool — no fixed per-user
// ratio — but neither modality may drop below MODALITY_FLOOR (≈ a 10:1 hard bottom) so the feed is
// never single-modality.
const IMAGE_POLICY_BONUS = 0.05;
const MODALITY_FLOOR = 1 / 11;
// NSFW: the penalty hardens as the user matures. New users (α≈0) see sensitive posts unpenalized;
// established users who hide sensitive content get a hard demotion. (No penalty either way when the
// user has opted to show sensitive content — penalizeSensitive=false.)
const SENSITIVE_PENALTY_NEW = 1.0;
const SENSITIVE_PENALTY_ESTABLISHED = 0.1;

/** Per-note content features, cached in Redis (`rec:feat:{noteId}`), computed off the hot path. */
type NoteFeatures = {
	/** LLM interestingness 1-5, or null if unscored. */
	q: number | null;
	/** Deterministic structural quality ∈ [0,1] (always present; fallback when q is null). */
	sq: number;
	readableLength: number;
	readableRatio: number;
	hasImage: boolean;
	imageCount: number;
};

/** Serve-time score breakdown, carried through the queue so impressions can log training features. */
type CandidateFeatures = {
	ann: number;
	quality: number;
	recency: number;
	langW: number;
	alpha: number;
	score: number;
	followed: boolean;
	mm: boolean;
};

type ScoredCandidate = {
	noteId: string;
	source: CandidateSource;
	annScore: number;
	feat?: CandidateFeatures;
};

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
	private logger: Logger;
	private globalRankingCache: string[] = [];
	private globalRankingCacheAt = 0;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteRecommendationImpressionsRepository)
		private noteRecommendationImpressionsRepository: NoteRecommendationImpressionsRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.config)
		private config: Config,

		private featuredService: FeaturedService,
		private queryService: QueryService,
		private cacheService: CacheService,
		private idService: IdService,
		private milvusService: MilvusService,
		private llmQualityService: LlmQualityService,
		private queueService: QueueService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Resolves the language set used to filter a user's feed. We recommend only in the user's own
	 * language: the request-supplied UI locale wins, then the stored profile language, then the
	 * instance default. zh-CN/zh-TW collapse to zh via {@link normalizeLang}.
	 */
	@bindThis
	public async resolveLangs(userId: MiUser['id'] | null, requestedLang?: string | null): Promise<string[]> {
		const fromRequest = this.normalizeLang(requestedLang);
		if (fromRequest) return [fromRequest];

		if (userId) {
			const profile = await this.userProfilesRepository.findOneBy({ userId });
			const fromProfile = this.normalizeLang(profile?.lang);
			if (fromProfile) return [fromProfile];
		}

		const fallback = this.config.recommendation?.supportedLangs?.[0] ?? 'en';
		return [this.normalizeLang(fallback) ?? 'en'];
	}

	/**
	 * Normalizes a language tag to the short form used for matching. Region is stripped and all
	 * Chinese variants (zh-CN / zh-TW / zh-Hant …) collapse to `zh`.
	 */
	@bindThis
	public normalizeLang(lang: string | null | undefined): string | null {
		if (lang == null) return null;
		const base = lang.toLowerCase().trim().split(/[-_]/)[0];
		if (base === '') return null;
		if (base === 'zh') return 'zh';
		return base;
	}

	// #region engagement → interest

	/**
	 * Records a positive engagement so it feeds the user's interest vector. The numeric signal
	 * weight is computed from the kind (and, for reactions, whether it's a rare/custom emoji) and
	 * stored alongside the note id; the interest vector is marked dirty for lazy recompute.
	 */
	@bindThis
	public async onPositiveEngagement(userId: MiUser['id'], note: Pick<MiNote, 'id' | 'lang'>, kind: EngagementKind, opts?: { reaction?: string }): Promise<void> {
		const weight = this.signalWeight(kind, opts?.reaction);
		const lang = this.normalizeLang(note.lang);
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
			// Make sure the liked note is embedded even if it came from somewhere outside the rec feed
			// (home timeline, an older note, etc.), so every like can contribute to the interest vector.
			this.queueService.createEmbedNoteJob(note.id).catch(() => { /* best-effort */ });
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
		const next = (cur != null && cur.length === nv.length)
			? cur.map((x, i) => (1 - alpha) * x + alpha * nv![i])
			: nv.slice();

		const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return;

		await this.redisForTimelines.multi()
			.set(key, JSON.stringify(next.map(x => x / norm)), 'EX', PUSHED_TTL_SEC)
			.hincrby(`rec:modality:${userId}`, modality, 1)
			.expire(`rec:modality:${userId}`, PUSHED_TTL_SEC)
			.exec();
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

	@bindThis
	private async getInterestVectors(userId: MiUser['id']): Promise<{ mm: number[] | null; txt: number[] | null }> {
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
	 * EMA-replays the engaged notes (oldest→newest) within ONE modality's embeddings, then applies the
	 * Rocchio soft-negative term using same-modality negatives. Returns a unit vector or null.
	 */
	@bindThis
	private buildModalityVector(parsed: { weight: number; noteId: string }[], vectors: Map<string, number[]>, negVecs: number[][]): number[] | null {
		let dim = 0;
		for (const v of vectors.values()) { dim = v.length; break; }
		if (dim === 0) return null;

		let pos: number[] | null = null;
		for (let i = parsed.length - 1; i >= 0; i--) {
			const vec = vectors.get(parsed[i].noteId);
			if (!vec || vec.length !== dim) continue;
			if (pos == null) {
				pos = vec.slice();
			} else {
				const alpha = Math.min(0.5, EMA_ALPHA * parsed[i].weight);
				for (let d = 0; d < dim; d++) pos[d] = (1 - alpha) * pos[d] + alpha * vec[d];
			}
		}
		if (pos == null) return null;

		let negCount = 0;
		const neg = new Array<number>(dim).fill(0);
		for (const vec of negVecs) {
			if (vec.length !== dim) continue;
			for (let d = 0; d < dim; d++) neg[d] += vec[d];
			negCount++;
		}

		const acc = pos.map((x, d) => x - (negCount > 0 ? SOFT_NEGATIVE_WEIGHT * (neg[d] / negCount) : 0));
		const norm = Math.sqrt(acc.reduce((s, x) => s + x * x, 0));
		if (norm === 0) return null;
		return acc.map(x => x / norm);
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

		const allIds = [...engagedSet, ...negIds];
		const [mmVecs, txtVecs] = await Promise.all([
			this.milvusService.getNoteVectors(allIds, 'mm'),
			this.milvusService.getNoteVectors(allIds, 'txt'),
		]);

		const mmNeg = negIds.map(id => mmVecs.get(id)).filter((v): v is number[] => v != null);
		const txtNeg = negIds.map(id => txtVecs.get(id)).filter((v): v is number[] => v != null);
		const mm = this.buildModalityVector(parsed, mmVecs, mmNeg);
		const txt = this.buildModalityVector(parsed, txtVecs, txtNeg);

		// Modality engagement counts (for the blend ratio): which collection each engaged note lives in.
		let mmCount = 0;
		let txtCount = 0;
		for (const p of parsed) {
			if (mmVecs.has(p.noteId)) mmCount++;
			else if (txtVecs.has(p.noteId)) txtCount++;
		}

		const pipe = this.redisForTimelines.multi();
		if (mm != null) pipe.set(`rec:uvec:mm:${userId}`, JSON.stringify(mm), 'EX', PUSHED_TTL_SEC); else pipe.del(`rec:uvec:mm:${userId}`);
		if (txt != null) pipe.set(`rec:uvec:txt:${userId}`, JSON.stringify(txt), 'EX', PUSHED_TTL_SEC); else pipe.del(`rec:uvec:txt:${userId}`);
		pipe.del(`rec:modality:${userId}`);
		if (mmCount > 0) pipe.hset(`rec:modality:${userId}`, 'mm', mmCount);
		if (txtCount > 0) pipe.hset(`rec:modality:${userId}`, 'txt', txtCount);
		if (mmCount > 0 || txtCount > 0) pipe.expire(`rec:modality:${userId}`, PUSHED_TTL_SEC);
		pipe.del(`rec:dirty:${userId}`);
		await pipe.exec();

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

	/**
	 * One-off backfill: enqueues embed jobs for public, supported-language text notes from the last
	 * `days` days (newest-first, so recent content becomes recommendable soonest), up to `limit`.
	 * Streams in id-keyset batches so it never loads the whole window into memory. Runs in the
	 * background; the embed worker drains the queue and logs any failures.
	 */
	@bindThis
	public async prefillRecent(days: number, limit: number, langs?: string[], imagesOnly = false): Promise<number> {
		const targetLangs = (langs && langs.length > 0 ? langs : this.config.recommendation?.supportedLangs) ?? ['zh', 'en', 'ja'];
		const sinceId = this.idService.gen(Date.now() - days * 24 * 60 * 60 * 1000);
		let lastId: string | null = null;
		let total = 0;
		this.logger.info(`prefill started: days=${days} limit=${limit} langs=${targetLangs.join(',')} imagesOnly=${imagesOnly} sinceId=${sinceId}`);
		while (total < limit) {
			const take = Math.min(1000, limit - total);
			const q = this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id')
				.where('note.id > :sinceId', { sinceId })
				.andWhere('note.visibility = \'public\'')
				.andWhere('note.channelId IS NULL')
				.andWhere('note.text IS NOT NULL')
				.andWhere('note.lang IN (:...langs)', { langs: targetLangs })
				.orderBy('note.id', 'DESC')
				.limit(take);
			// Multimodal re-embed: only notes that actually carry an image attachment.
			if (imagesOnly) {
				q.andWhere('array_length(note."fileIds", 1) > 0')
					.andWhere('EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(note."fileIds") AND df.type LIKE \'image/%\')');
			}
			if (lastId != null) q.andWhere('note.id < :lastId', { lastId });

			const batch = await q.getRawMany<{ id: string }>();
			if (batch.length === 0) break;
			for (const row of batch) {
				await this.queueService.createEmbedNoteJob(row.id);
			}
			total += batch.length;
			lastId = batch[batch.length - 1].id;
			if (total % 10000 === 0) this.logger.info(`prefill enqueued ${total}…`);
		}
		this.logger.info(`prefill done: enqueued ${total} embed job(s)`);
		return total;
	}

	/**
	 * Backfills content-quality features for recent public notes that don't have them yet (e.g. notes
	 * embedded before quality scoring existed). Enqueues quality-only jobs (no re-embedding) for notes
	 * within the last `days`, skipping any that already have a cached feature blob. Old notes are never
	 * recommended, so there's no value scoring beyond the recency window.
	 */
	@bindThis
	public async backfillQuality(days: number, limit: number, langs?: string[]): Promise<number> {
		const targetLangs = (langs ?? this.config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase());
		const sinceId = this.idService.gen(Date.now() - days * 24 * 60 * 60 * 1000);
		let lastId: string | null = null;
		let enqueued = 0;
		let scanned = 0;
		this.logger.info(`quality backfill started: days=${days} limit=${limit} langs=${targetLangs.join(',')}`);
		while (scanned < limit) {
			const take = Math.min(1000, limit - scanned);
			const q = this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id')
				.where('note.id > :sinceId', { sinceId })
				.andWhere('note.visibility = \'public\'')
				.andWhere('note.channelId IS NULL')
				.andWhere('note.text IS NOT NULL')
				.andWhere('note.lang IN (:...langs)', { langs: targetLangs })
				.orderBy('note.id', 'DESC')
				.limit(take);
			if (lastId != null) q.andWhere('note.id < :lastId', { lastId });

			const batch = await q.getRawMany<{ id: string }>();
			if (batch.length === 0) break;
			// Skip notes that already have features cached (avoid re-scoring on repeat backfills).
			const existing = await this.redisForTimelines.mget(...batch.map(r => `rec:feat:${r.id}`));
			for (let i = 0; i < batch.length; i++) {
				if (existing[i] != null) continue;
				await this.queueService.createScoreQualityJob(batch[i].id);
				enqueued++;
			}
			scanned += batch.length;
			lastId = batch[batch.length - 1].id;
		}
		this.logger.info(`quality backfill done: scanned ${scanned}, enqueued ${enqueued} quality job(s)`);
		return enqueued;
	}

	/**
	 * Cold-start for existing users: seeds the interest vector + language affinity from their whole
	 * engagement history (reactions, favourites, renotes/quotes, replies) plus a light positive from
	 * the recent posts of people they follow. Enqueues embeds for the seed notes and recomputes the
	 * vector; the daily reconciliation refines it as late embeds land. Returns the number of seeds.
	 */
	@bindThis
	public async backfillUserFromHistory(userId: MiUser['id']): Promise<number> {
		const collected = new Map<string, number>(); // noteId -> strongest signal weight, newest-first
		const add = (noteId: string | null | undefined, w: number) => {
			if (!noteId) return;
			const cur = collected.get(noteId);
			if (cur == null || w > cur) collected.set(noteId, w);
		};

		const reactions = await this.notesRepository.manager.query(
			'SELECT "noteId", "reaction" FROM note_reaction WHERE "userId" = $1 ORDER BY id DESC LIMIT 500', [userId]) as { noteId: string; reaction: string }[];
		for (const r of reactions) add(r.noteId, typeof r.reaction === 'string' && r.reaction.includes(':') ? REACTION_RARE_WEIGHT : REACTION_NORMAL_WEIGHT);

		const favs = await this.notesRepository.manager.query(
			'SELECT "noteId" FROM note_favorite WHERE "userId" = $1 ORDER BY id DESC LIMIT 300', [userId]) as { noteId: string }[];
		for (const f of favs) add(f.noteId, FAVORITE_WEIGHT);

		const refs = await this.notesRepository.manager.query(
			'SELECT "renoteId", "replyId" FROM note WHERE "userId" = $1 AND ("renoteId" IS NOT NULL OR "replyId" IS NOT NULL) ORDER BY id DESC LIMIT 500', [userId]) as { renoteId: string | null; replyId: string | null }[];
		for (const n of refs) { add(n.renoteId, RENOTE_WEIGHT); add(n.replyId, REPLY_WEIGHT); }

		// Light follow seed: recent posts from people they follow (following ≠ liking, so low weight).
		const followedSet = await this.getFollowedSet(userId);
		if (followedSet.size > 0) {
			const sinceId = this.idService.gen(Date.now() - 30 * 24 * 60 * 60 * 1000);
			const followNotes = await this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id')
				.where('note.userId IN (:...ids)', { ids: [...followedSet] })
				.andWhere('note.id > :sinceId', { sinceId })
				.andWhere('note.text IS NOT NULL')
				.orderBy('note.id', 'DESC')
				.limit(FOLLOW_SEED_MAX)
				.getRawMany<{ id: string }>();
			for (const fn of followNotes) add(fn.id, FOLLOW_SEED_WEIGHT);
		}

		const entries = [...collected.entries()].slice(0, ENGAGED_MAX);
		if (entries.length === 0) return 0;
		const ids = entries.map(([noteId]) => noteId);

		// Language affinity from the seed notes' languages.
		const langRows = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id').addSelect('note.lang', 'lang')
			.where('note.id IN (:...ids)', { ids })
			.getRawMany<{ id: string; lang: string | null }>();
		const langOf = new Map(langRows.map(r => [r.id, r.lang]));
		const langAgg = new Map<string, number>();
		for (const [noteId, w] of entries) {
			const l = this.normalizeLang(langOf.get(noteId));
			if (l) langAgg.set(l, (langAgg.get(l) ?? 0) + w);
		}

		const pipe = this.redisForTimelines.multi();
		pipe.del(`rec:engaged:${userId}`);
		for (const [noteId, w] of entries) pipe.rpush(`rec:engaged:${userId}`, `${w}:${noteId}`); // head = most-recent
		pipe.expire(`rec:engaged:${userId}`, PUSHED_TTL_SEC);
		pipe.del(`rec:langaff:${userId}`);
		for (const [l, w] of langAgg) pipe.hincrbyfloat(`rec:langaff:${userId}`, l, w);
		if (langAgg.size > 0) pipe.expire(`rec:langaff:${userId}`, PUSHED_TTL_SEC);
		pipe.sadd('rec:users', userId);
		pipe.set(`rec:dirty:${userId}`, '1');
		await pipe.exec();

		for (const noteId of ids) this.queueService.createEmbedNoteJob(noteId).catch(() => { /* best-effort */ });
		await this.recomputeInterestVectors(userId);

		this.logger.info(`history backfill for ${userId}: seeded ${entries.length} engagements`);
		return entries.length;
	}

	/**
	 * Runs {@link backfillUserFromHistory} for every local user that has any reaction history.
	 * One-off background job; logs progress.
	 */
	@bindThis
	public async backfillAllUsersFromHistory(): Promise<number> {
		const rows = await this.notesRepository.manager.query(
			'SELECT DISTINCT r."userId" AS id FROM note_reaction r JOIN "user" u ON u.id = r."userId" WHERE u.host IS NULL') as { id: string }[];
		let count = 0;
		for (const { id } of rows) {
			try {
				if (await this.backfillUserFromHistory(id) > 0) count++;
			} catch (err) {
				this.logger.warn(`history backfill for ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.logger.info(`history backfill complete: seeded ${count} user(s)`);
		return count;
	}

	// #endregion

	// #region note features (quality)

	/**
	 * Computes and caches a note's content features: the deterministic structural quality (always) and
	 * the LLM interestingness score (best-effort, 1-5). Called from the embed worker, which already has
	 * the note's downscaled images, so no extra download happens. Never throws — quality is optional.
	 */
	@bindThis
	public async recordNoteFeatures(noteId: MiNote['id'], text: string | null, imageDataUrls: string[]): Promise<void> {
		try {
			const analysis = analyzeNoteText(text);
			const hasImage = imageDataUrls.length > 0;
			const sq = structuralQuality(analysis, hasImage);
			// LLM score is best-effort: scoreNote already returns null on any failure / when disabled.
			const q = this.llmQualityService.enabled ? await this.llmQualityService.scoreNote(text ?? '', imageDataUrls) : null;

			const feat: NoteFeatures = {
				q,
				sq,
				readableLength: analysis.readableLength,
				readableRatio: analysis.readableRatio,
				hasImage,
				imageCount: imageDataUrls.length,
			};
			await this.redisForTimelines.set(`rec:feat:${noteId}`, JSON.stringify(feat), 'EX', FEATURE_TTL_SEC);
		} catch (err) {
			this.logger.warn(`recordNoteFeatures failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Loads cached features for the given notes (one pipelined read). Missing notes are absent. */
	@bindThis
	private async getNoteFeatures(noteIds: string[]): Promise<Map<string, NoteFeatures>> {
		const out = new Map<string, NoteFeatures>();
		if (noteIds.length === 0) return out;
		try {
			const raws = await this.redisForTimelines.mget(...noteIds.map(id => `rec:feat:${id}`));
			noteIds.forEach((id, i) => {
				const raw = raws[i];
				if (raw == null) return;
				try { out.set(id, JSON.parse(raw) as NoteFeatures); } catch { /* skip */ }
			});
		} catch (err) {
			this.logger.warn(`getNoteFeatures failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return out;
	}

	/**
	 * Normalized content-quality ∈ [0,1] for a note: LLM score if present, else the structural score,
	 * else 0. Notes we've never processed default to 0 (rather than a neutral guess) so unscored content
	 * is deprioritized until the backfill/worker fills it in — there's no "free pass" for missing scores.
	 */
	@bindThis
	private qualityOf(feat: NoteFeatures | undefined): number {
		if (feat == null) return 0;
		return feat.q != null ? llmTo01(feat.q) : feat.sq;
	}

	// #endregion

	// #region candidate generation

	@bindThis
	private async getGlobalRankingCached(): Promise<string[]> {
		if (this.globalRankingCacheAt !== 0 && Date.now() - this.globalRankingCacheAt < 1000 * 60 * 30) {
			return this.globalRankingCache;
		}
		const ids = await this.featuredService.getGlobalNotesRanking(FEATURED_THRESHOLD);
		this.globalRankingCache = ids;
		this.globalRankingCacheAt = Date.now();
		return ids;
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
	private queueKey(userId: MiUser['id'], langs: string[]): string {
		return `rec:queue:${userId}:${langs[0] ?? 'all'}`;
	}

	/**
	 * Effective per-language weights in [0,1]. The selected language always carries at least
	 * BASE_SELECTED_LANG; another language's weight rises along a smooth, conservative curve (logistic
	 * in like-share × sample confidence) so it only matters once the user overwhelmingly and
	 * significantly engages in it — never a hard switch.
	 */
	@bindThis
	private async getLangWeights(userId: MiUser['id'], selectedLang: string): Promise<{ weights: Map<string, number>; total: number }> {
		const weights = new Map<string, number>();

		const aff = await this.redisForTimelines.hgetall(`rec:langaff:${userId}`);
		const entries = Object.entries(aff).map(([lang, v]) => [lang, Number(v) || 0] as const);
		const total = entries.reduce((s, [, v]) => s + v, 0);

		// The selected (UI) language always carries at least the base weight, up to its own like-share.
		const selShare = total > 0 ? (Number(aff[selectedLang]) || 0) / total : 0;
		weights.set(selectedLang, Math.min(1, Math.max(BASE_SELECTED_LANG, selShare)));

		if (total > 0) {
			// Confidence in the sample, continuous in total (≈0.5 at K, →1 for large samples).
			const sampleFactor = total / (total + CROSS_LANG_SAMPLE_K);
			for (const [lang, v] of entries) {
				if (lang === selectedLang) continue;
				const share = v / total;
				// Logistic ramp centred at the share midpoint — smooth, ~0 well below it, ~1 well above.
				const shareFactor = 1 / (1 + Math.exp(-(share - CROSS_LANG_SHARE_MIDPOINT) / CROSS_LANG_SHARE_TEMP));
				const w = share * shareFactor * sampleFactor;
				// Skip only negligible weights (keeps effectiveLangs tidy); the curve itself is continuous.
				if (w > 0.02) weights.set(lang, Math.min(1, w));
			}
		}
		return { weights, total };
	}

	/** Total weighted language-affinity signal — used to decide whether to trust the user's language. */
	@bindThis
	private async langAffinityTotal(userId: MiUser['id']): Promise<number> {
		const aff = await this.redisForTimelines.hgetall(`rec:langaff:${userId}`);
		return Object.values(aff).reduce((s, v) => s + (Number(v) || 0), 0);
	}

	@bindThis
	private async getFollowedSet(userId: MiUser['id']): Promise<Set<string>> {
		try {
			const followings = await this.cacheService.userFollowingsCache.fetch(userId);
			return new Set(followings.keys());
		} catch {
			return new Set();
		}
	}

	/**
	 * Recent notes from the people the user follows, as a candidate source (so followed authors'
	 * posts appear and can be boosted). Visibility is re-checked later in loadAndFilterNotes.
	 */
	@bindThis
	private async getFollowedRecentNotes(followedSet: Set<string>, langs: string[]): Promise<string[]> {
		if (followedSet.size === 0) return [];
		const sinceId = this.idService.gen(Date.now() - FOLLOWED_RECENT_DAYS * 24 * 60 * 60 * 1000);
		const rows = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.where('note.userId IN (:...ids)', { ids: [...followedSet] })
			.andWhere('note.id > :sinceId', { sinceId })
			.andWhere('note.channelId IS NULL')
			.andWhere('note.text IS NOT NULL')
			.andWhere('(note.lang IN (:...langs) OR note.lang IS NULL)', { langs })
			.orderBy('note.id', 'DESC')
			.limit(FOLLOWED_CANDIDATE_LIMIT)
			.getRawMany<{ id: string }>();
		return rows.map(r => r.id);
	}

	@bindThis
	public async buildCandidateQueue(userId: MiUser['id'], langs: string[], penalizeSensitive = true): Promise<number> {
		const selectedLang = langs[0] ?? 'en';
		const key = this.queueKey(userId, langs);

		const [{ weights: langWeights, total: langAffTotal }, followedSet, interest] = await Promise.all([
			this.getLangWeights(userId, selectedLang),
			this.getFollowedSet(userId),
			this.getInterestVectors(userId),
		]);
		const effectiveLangs = [...langWeights.keys()];
		const nullLangWeight = langAffTotal >= STRICT_LANG_MIN_AFFINITY ? 0 : NULL_LANG_WEIGHT;
		// Cold/warm gate: α rises from 0 (brand-new) toward 1 (veteran) with accumulated engagement.
		// At α≈0 the feed is quality+recency; at α→1 it's personal relevance.
		const alpha = langAffTotal / (langAffTotal + CONFIDENCE_K);

		// Retrieve each modality from its OWN collection with its OWN interest vector (never mixed).
		const [annMm, annTxt, perUserIds, globalIds, followedIds, remaining] = await Promise.all([
			interest.mm ? this.milvusService.searchByVector(interest.mm, ANN_TOPK, effectiveLangs, 'mm') : Promise.resolve([]),
			interest.txt ? this.milvusService.searchByVector(interest.txt, ANN_TOPK, effectiveLangs, 'txt') : Promise.resolve([]),
			this.featuredService.getPerUserNotesRanking(userId, FEATURED_THRESHOLD),
			this.getGlobalRankingCached(),
			this.getFollowedRecentNotes(followedSet, effectiveLangs),
			this.redisForTimelines.lrange(key, 0, -1),
		]);

		const candidates = new Map<string, ScoredCandidate>();
		const consider = (noteId: string, source: CandidateSource, annScore: number) => {
			const existing = candidates.get(noteId);
			if (existing == null) {
				candidates.set(noteId, { noteId, source, annScore });
			} else if (annScore > existing.annScore) {
				existing.annScore = annScore;
			}
		};
		for (const hit of annMm) consider(hit.noteId, 'ann', hit.score);
		for (const hit of annTxt) consider(hit.noteId, 'ann', hit.score);
		for (const id of perUserIds) consider(id, 'perUser', 0);
		for (const id of followedIds) consider(id, 'following', 0);
		for (const id of globalIds) consider(id, 'global', 0);
		// Preserve still-unseen queued notes across rebuilds (refresh must not discard them).
		for (const entry of remaining) {
			const parsed = this.parseQueueEntry(entry);
			if (parsed) consider(parsed.noteId, parsed.source, 0);
		}

		// Remove already-pushed notes.
		const pushed = new Set(await this.redisForTimelines.zrange(`rec:pushed:${userId}`, 0, -1));
		for (const id of pushed) candidates.delete(id);

		if (candidates.size === 0) {
			const tail = await this.getRecentLangTail(userId, effectiveLangs, [...pushed], 100);
			for (const id of tail) consider(id, 'fallback', 0);
		}

		// One unified ranking over all candidates (quality drives the image:text mix; no fixed ratio).
		// `mmIds`/`features` are looked up once and shared with the ranker and the modality-floor pass.
		const candIds = [...candidates.keys()];
		const [mmIds, features] = await Promise.all([
			this.getMultimodalNoteIds(candIds),
			this.getNoteFeatures(candIds),
		]);
		const ranked = await this.rankCandidates(userId, [...candidates.values()], langWeights, followedSet, nullLangWeight, penalizeSensitive, alpha, mmIds, features);
		// Let the mix drift with pool quality, but guarantee neither modality drops below the floor.
		const ordered = this.enforceModalityFloor(ranked, mmIds, MODALITY_FLOOR);

		const tx = this.redisForTimelines.multi().del(key);
		if (ordered.length > 0) {
			tx.rpush(key, ...ordered.map(c => this.serializeQueueEntry(c)));
			tx.expire(key, QUEUE_TTL_SEC);
		}
		await tx.exec();
		return ordered.length;
	}

	/** Queue entries are JSON so they can carry the serve-time score breakdown (for impression logging). */
	@bindThis
	private serializeQueueEntry(c: ScoredCandidate): string {
		return JSON.stringify({ s: c.source, n: c.noteId, f: c.feat });
	}

	@bindThis
	private parseQueueEntry(entry: string): { source: CandidateSource; noteId: string; feat?: CandidateFeatures } | null {
		// Current format is JSON; tolerate the legacy `source:noteId` string for queues built pre-upgrade.
		if (entry.startsWith('{')) {
			try {
				const o = JSON.parse(entry) as { s: CandidateSource; n: string; f?: CandidateFeatures };
				if (o && typeof o.n === 'string') return { source: o.s, noteId: o.n, feat: o.f };
			} catch { /* fall through */ }
			return null;
		}
		const idx = entry.indexOf(':');
		if (idx < 0) return null;
		return { source: entry.slice(0, idx) as CandidateSource, noteId: entry.slice(idx + 1) };
	}

	/** Of the given notes, which carry an image attachment (i.e. live in the multimodal collection). */
	@bindThis
	private async getMultimodalNoteIds(noteIds: string[]): Promise<Set<string>> {
		if (noteIds.length === 0) return new Set();
		try {
			const rows = await this.notesRepository.manager.query(
				'SELECT n.id FROM note n WHERE n.id = ANY($1) AND EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(n."fileIds") AND df.type LIKE \'image/%\')',
				[noteIds]) as { id: string }[];
			return new Set(rows.map(r => r.id));
		} catch (err) {
			this.logger.warn(`getMultimodalNoteIds failed: ${err instanceof Error ? err.message : String(err)}`);
			return new Set();
		}
	}

	/**
	 * Re-orders a single quality-ranked stream so the image:text mix is driven by post quality, while
	 * guaranteeing neither modality falls below `floor` of the result (≈ a 10:1 hard bottom). It walks
	 * in global score order, but forces the under-represented modality whenever it would otherwise be
	 * impossible to meet its floor in the remaining slots. Score order is read from each item's `feat`.
	 */
	@bindThis
	private enforceModalityFloor(ranked: ScoredCandidate[], mmIds: Set<string>, floor: number): ScoredCandidate[] {
		const mm = ranked.filter(c => mmIds.has(c.noteId));
		const txt = ranked.filter(c => !mmIds.has(c.noteId));
		const total = ranked.length;
		if (mm.length === 0 || txt.length === 0) return ranked; // only one modality present — nothing to balance
		const quota = Math.ceil(floor * total); // minimum each modality must reach if it has the supply

		const out: ScoredCandidate[] = [];
		let mi = 0;
		let ti = 0;
		let mmUsed = 0;
		let txtUsed = 0;
		const scoreOf = (c: ScoredCandidate | undefined): number => c?.feat?.score ?? 0;
		for (let pos = 0; pos < total; pos++) {
			const remaining = total - pos;
			const needMm = Math.max(0, Math.min(quota, mm.length) - mmUsed);
			const needTxt = Math.max(0, Math.min(quota, txt.length) - txtUsed);
			let takeMm: boolean;
			if (needMm >= remaining && mi < mm.length) takeMm = true; // must fill mm to hit its floor
			else if (needTxt >= remaining && ti < txt.length) takeMm = false; // must fill txt
			else if (mi >= mm.length) takeMm = false;
			else if (ti >= txt.length) takeMm = true;
			else takeMm = scoreOf(mm[mi]) >= scoreOf(txt[ti]); // otherwise follow global quality order
			if (takeMm) { out.push(mm[mi++]); mmUsed++; } else { out.push(txt[ti++]); txtUsed++; }
		}
		return out;
	}

	/**
	 * Loads candidate notes, drops anything not visible/allowed, and scores each as
	 *   score = (α·relevance + (1−α)·qualityPrior)·langWeight + followBonus + imagePolicy , ×nsfwPenalty
	 * where qualityPrior = QP_QUALITY·quality + QP_RECENCY·recency + QP_ENGAGEMENT·popularity. α is the
	 * cold/warm gate: new users lean on the quality prior, veterans on personal relevance. The full
	 * score breakdown is stashed on each candidate's `feat` for impression logging. A per-author cap
	 * then keeps the top of the feed diverse.
	 */
	@bindThis
	private async rankCandidates(userId: MiUser['id'], candidates: ScoredCandidate[], langWeights: Map<string, number>, followedSet: Set<string>, nullLangWeight: number, penalizeSensitive: boolean, alpha: number, mmIds: Set<string>, features: Map<string, NoteFeatures>): Promise<ScoredCandidate[]> {
		if (candidates.length === 0) return [];
		const byId = new Map(candidates.map(c => [c.noteId, c]));
		const notes = await this.loadAndFilterNotes([...byId.keys()], userId);

		// Which of these notes carry sensitive/NSFW media (only computed when we'll penalize them).
		const sensitiveIds = penalizeSensitive ? await this.getSensitiveNoteIds(notes.map(n => n.id)) : new Set<string>();
		// NSFW penalty hardens with the user's RAW maturity: α≈0 (new) → no penalty (they see it);
		// α→1 → hard demote. (Unaffected by the quality-prior floor below.)
		const sensitiveMult = SENSITIVE_PENALTY_NEW + (SENSITIVE_PENALTY_ESTABLISHED - SENSITIVE_PENALTY_NEW) * alpha;
		// Gate used for the relevance/quality blend, capped so the quality prior keeps ≥ QUALITY_PRIOR_FLOOR
		// weight even for veterans (quality is intrinsic, not a cold-start crutch). Only binds for
		// established users; new users keep their tiny α unchanged.
		const alphaBlend = Math.min(alpha, 1 - QUALITY_PRIOR_FLOOR);

		const now = Date.now();
		const scored: { cand: ScoredCandidate; authorId: string; score: number }[] = [];
		for (const note of notes) {
			const cand = byId.get(note.id);
			if (cand == null) continue;

			// Soft language weight: selected/liked languages high, unknown-language low (or dropped for
			// established users), other languages dropped.
			const norm = this.normalizeLang(note.lang);
			const langW = norm != null ? (langWeights.get(norm) ?? 0) : nullLangWeight;
			if (langW <= 0) continue;

			const isMm = mmIds.has(note.id);
			const relevance = Math.max(0, Math.min(1, cand.annScore)); // cosine ∈ [-1,1] → clamp to [0,1]
			const quality = this.qualityOf(features.get(note.id));
			const engagementRaw = this.engagementOf(note);
			const engagement = Math.min(1, Math.log1p(engagementRaw) / Math.log1p(1000)); // soft-normalize
			const ageHours = (now - this.idService.parse(note.id).date.getTime()) / (1000 * 60 * 60);
			const recency = Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);

			// User-independent value of the note.
			const qualityPrior = QP_QUALITY * quality + QP_RECENCY * recency + QP_ENGAGEMENT * engagement;
			// Blend personal relevance vs quality by the (floored) cold/warm gate.
			const base = alphaBlend * relevance + (1 - alphaBlend) * qualityPrior;
			// Language scales the blended score; following + the image policy add flat lifts on top.
			let score = base * langW + (followedSet.has(note.userId) ? W_FOLLOW : 0) + (isMm ? IMAGE_POLICY_BONUS : 0);
			if (sensitiveIds.has(note.id)) score *= sensitiveMult;

			cand.feat = { ann: relevance, quality, recency, langW, alpha, score, followed: followedSet.has(note.userId), mm: isMm };
			scored.push({ cand, authorId: note.userId, score });
		}

		scored.sort((a, b) => b.score - a.score);

		// Diversity: take at most MAX_PER_AUTHOR per author into the primary run; demote the overflow
		// to the tail (kept, not dropped) so one prolific/followed account can't dominate the feed.
		const perAuthor = new Map<string, number>();
		const primary: ScoredCandidate[] = [];
		const overflow: ScoredCandidate[] = [];
		for (const s of scored) {
			const n = perAuthor.get(s.authorId) ?? 0;
			if (n < MAX_PER_AUTHOR) {
				primary.push(s.cand);
				perAuthor.set(s.authorId, n + 1);
			} else {
				overflow.push(s.cand);
			}
		}
		return [...primary, ...overflow];
	}

	/**
	 * Of the given notes, which carry sensitive/NSFW media (any attached file flagged sensitive).
	 * One query over the candidate set; returns an empty set on error (best-effort).
	 */
	@bindThis
	private async getSensitiveNoteIds(noteIds: string[]): Promise<Set<string>> {
		if (noteIds.length === 0) return new Set();
		try {
			const rows = await this.notesRepository.manager.query(
				'SELECT n.id FROM note n WHERE n.id = ANY($1) AND EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(n."fileIds") AND df."isSensitive" = true)',
				[noteIds]) as { id: string }[];
			return new Set(rows.map(r => r.id));
		} catch (err) {
			this.logger.warn(`getSensitiveNoteIds failed: ${err instanceof Error ? err.message : String(err)}`);
			return new Set();
		}
	}

	@bindThis
	private engagementOf(note: Pick<MiNote, 'reactions' | 'renoteCount' | 'repliesCount'>): number {
		let reactions = 0;
		for (const v of Object.values(note.reactions ?? {})) reactions += v;
		return reactions + note.renoteCount + note.repliesCount;
	}

	/**
	 * Loads notes by id with the relations packMany needs, applying visibility/mute/block/host
	 * filtering. Result order is not guaranteed (callers reorder as needed).
	 */
	@bindThis
	private async loadAndFilterNotes(noteIds: string[], meId: MiUser['id'] | null): Promise<MiNote[]> {
		if (noteIds.length === 0) return [];

		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds })
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser')
			.leftJoinAndSelect('note.channel', 'channel')
			.andWhere('note.channelId IS NULL')
			.andWhere('user.isExplorable = TRUE');

		this.queryService.generateBlockedHostQueryForNote(query);
		const me = meId ? { id: meId } : null;
		this.queryService.generateVisibilityQuery(query, me);
		if (me) {
			this.queryService.generateMutedUserQueryForNotes(query, me);
			this.queryService.generateBlockedUserQueryForNotes(query, me);
		}

		const [muting, blocked] = meId ? await Promise.all([
			this.cacheService.userMutingsCache.fetch(meId),
			this.cacheService.userBlockedCache.fetch(meId),
		]) : [new Set<string>(), new Set<string>()];

		return (await query.getMany()).filter(note => {
			if (meId && isUserRelated(note, blocked)) return false;
			if (meId && isUserRelated(note, muting)) return false;
			return true;
		});
	}

	/**
	 * Recent public matched-language notes ordered newest-first, excluding the given ids. Used as the
	 * never-empty tail of the feed. Once a user has a clear language signal we keep this strict to
	 * their language(s); for cold users (or anonymous) we also allow undetected-language notes so the
	 * feed isn't empty before any signal exists.
	 */
	@bindThis
	private async getRecentLangTail(meId: MiUser['id'] | null, langs: string[], excludeIds: string[], limit: number): Promise<string[]> {
		const allowNull = meId == null ? true : (await this.langAffinityTotal(meId)) < STRICT_LANG_MIN_AFFINITY;
		const langCond = langs.length === 0
			? '1=1'
			: allowNull ? '(note.lang IN (:...langs) OR note.lang IS NULL)' : 'note.lang IN (:...langs)';
		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.where('note.visibility = \'public\'')
			.andWhere('note.channelId IS NULL')
			.andWhere('user.isExplorable = TRUE')
			.andWhere(langCond, { langs })
			.orderBy('note.id', 'DESC')
			.limit(Math.min(500, limit + excludeIds.length));

		this.queryService.generateBlockedHostQueryForNote(query);
		const me = meId ? { id: meId } : null;
		this.queryService.generateVisibilityQuery(query, me);

		const exclude = new Set(excludeIds);
		const ids: string[] = [];
		for (const note of await query.getMany()) {
			if (exclude.has(note.id)) continue;
			ids.push(note.id);
			if (ids.length >= limit) break;
		}
		return ids;
	}

	// #endregion

	// #region serving

	/**
	 * Returns the next page of recommended notes.
	 * - Logged-in: pops from the per-user candidate queue (lazily (re)building it when empty/low or
	 *   when `refresh` is set), logs impressions, and never repeats already-pushed notes.
	 * - Anonymous (userId null): serves global-popular + recent matched-language notes by `offset`,
	 *   with no impression logging.
	 */
	@bindThis
	public async getPage(userId: MiUser['id'] | null, langs: string[], limit: number, refresh: boolean, offset: number, penalizeSensitive = true): Promise<MiNote[]> {
		if (userId == null) {
			return this.getAnonymousPage(langs, limit, offset);
		}

		const key = this.queueKey(userId, langs);
		const len = await this.redisForTimelines.llen(key);
		// The algorithm runs on request, using the language the client sent (the server has no other
		// reliable source for the UI language). We rebuild on each feed-open (offset 0) — cheap for
		// rarely-online users since nothing runs unless they ask, and fresh for new users whose
		// interest shifts fast — or when the queue is low / the user explicitly refreshed. Load-more
		// (offset > 0) just pages the existing queue. Rebuild preserves still-unseen queued notes and
		// excludes already-pushed ones, so a refresh never repeats or discards unseen content.
		const isFreshLoad = offset === 0;
		if (refresh || isFreshLoad || len < QUEUE_LOW_WATERMARK) {
			await this.buildCandidateQueue(userId, langs, penalizeSensitive);
		}

		const popped = await this.redisForTimelines.lpop(key, limit);
		const entries = popped ?? [];

		const order: string[] = [];
		const sourceOf = new Map<string, CandidateSource>();
		const featOf = new Map<string, CandidateFeatures>();
		for (const entry of entries) {
			const parsed = this.parseQueueEntry(entry);
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
			const tail = await this.getRecentLangTail(userId, langs, exclude, limit - order.length);
			for (const id of tail) {
				order.push(id);
				sourceOf.set(id, 'fallback');
			}
		}

		const notes = await this.loadAndFilterNotes(order, userId);
		const ordered = this.reorder(notes, order);

		if (ordered.length > 0) {
			// `rank` is the position in the served page — a key feature/position-bias signal for training.
			await this.recordImpressions(userId, ordered.map((n, rank) => ({
				noteId: n.id,
				source: sourceOf.get(n.id) ?? 'fallback',
				rank,
				feat: featOf.get(n.id),
			})));
		}
		return ordered;
	}

	@bindThis
	private async getAnonymousPage(langs: string[], limit: number, offset: number): Promise<MiNote[]> {
		const globalIds = await this.getGlobalRankingCached();
		let notes = await this.loadAndFilterNotes(globalIds, null);
		// Keep only matched-language / null-language notes, popular order preserved.
		const langSet = new Set(langs);
		notes = this.reorder(notes, globalIds).filter(n => {
			const norm = this.normalizeLang(n.lang);
			return n.lang == null || (norm != null && langSet.has(norm));
		});

		let page = notes.slice(offset, offset + limit);
		if (page.length < limit) {
			// Backfill from the recent matched-language tail.
			const exclude = notes.map(n => n.id);
			const tailIds = await this.getRecentLangTail(null, langs, exclude, (offset + limit) - notes.length);
			const tailNotes = this.reorder(await this.loadAndFilterNotes(tailIds, null), tailIds);
			const combined = [...notes, ...tailNotes];
			page = combined.slice(offset, offset + limit);
		}
		return page;
	}

	@bindThis
	private reorder(notes: MiNote[], order: string[]): MiNote[] {
		const byId = new Map(notes.map(n => [n.id, n]));
		const out: MiNote[] = [];
		for (const id of order) {
			const n = byId.get(id);
			if (n) out.push(n);
		}
		return out;
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
				qualityScore: it.feat?.quality ?? null,
				recencyScore: it.feat?.recency ?? null,
				langWeight: it.feat?.langW ?? null,
				alpha: it.feat?.alpha ?? null,
				score: it.feat?.score ?? null,
				followed: it.feat?.followed ?? null,
				isMultimodal: it.feat?.mm ?? null,
			}))).catch(err => {
				this.logger.warn(`recordImpressions (sql) failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		} catch (err) {
			this.logger.warn(`recordImpressions (sql) threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// #endregion
}
