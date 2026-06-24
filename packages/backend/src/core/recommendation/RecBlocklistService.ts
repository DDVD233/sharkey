/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { IsNull } from 'typeorm';
import type { MiMeta, MiUser, NotesRepository, UsersRepository } from '@/models/_.js';
import * as Acct from '@/misc/acct.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import type Logger from '@/logger.js';
import { FEATURE_TTL_SEC } from './constants.js';
import { normalizeLang } from './lang.js';

@Injectable()
export class RecBlocklistService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,
		@Inject(DI.meta)
		private meta: MiMeta,
		private idService: IdService,
		private milvusService: MilvusService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	// Resolved blocklist cache: the admin enters acct handles in the control panel, but every hot-path
	// check needs user ids. We resolve handles → ids once and re-resolve only when the handle list
	// (snapshotted as a newline-joined key) actually changes — `meta` is a live, in-place-updated
	// reference (see GlobalModule's DI.meta provider), so edits propagate without an explicit subscription.
	private blockedAuthorCache: { key: string; ids: Set<string> } | null = null;

	/**
	 * Resolves the admin-configured recommendation blocklist (acct handles in `meta.recommendationBlockedUsers`)
	 * to a set of user ids. Cached and only recomputed when the handle list changes. Unresolvable handles
	 * (typos / not-yet-known remote users) are simply skipped. Best-effort: returns an empty set on error.
	 */
	@bindThis
	public async getBlockedAuthorIds(): Promise<Set<string>> {
		const handles = this.meta.recommendationBlockedUsers;
		const key = handles.join('\n');
		if (this.blockedAuthorCache?.key === key) return this.blockedAuthorCache.ids;

		const ids = new Set<string>();
		try {
			for (const handle of handles) {
				const acct = Acct.parse(handle);
				if (!acct.username) continue;
				const user = await this.usersRepository.findOneBy({
					usernameLower: acct.username.toLowerCase(),
					host: acct.host ?? IsNull(),
				});
				if (user) ids.add(user.id);
			}
			this.blockedAuthorCache = { key, ids };
		} catch (err) {
			this.logger.warn(`getBlockedAuthorIds failed: ${err instanceof Error ? err.message : String(err)}`);
			// Don't cache a partial result on error; reuse a prior good snapshot if we have one.
			return this.blockedAuthorCache?.ids ?? ids;
		}
		return ids;
	}

	/**
	 * Whether an author is excluded from the recommendation system entirely. Called from the embed/score
	 * queue processors (so a blocked author's notes never enter Milvus / the quality index) and used as a
	 * serve-time safety net in {@link loadAndFilterNotes} (so even notes reached via SQL sources — follow
	 * graph, recency tail — are dropped, and any vectors created before the user was blocked stay inert).
	 */
	@bindThis
	public async isAuthorBlocked(userId: MiUser['id']): Promise<boolean> {
		return (await this.getBlockedAuthorIds()).has(userId);
	}

	/**
	 * Admin-triggered hard purge of all recommendation data for the currently-blocklisted authors. The
	 * embed/score guards only stop NEW data; this removes what was created BEFORE a user was blocked:
	 * their note vectors (Milvus, both modalities), their author produce-centroids, and — by scanning the
	 * DB for their public notes — their entries in the per-language high-quality index and their cached
	 * note features. Their own feed state (interest vector, queue, engagement history) is left untouched —
	 * the blocklist governs whether they're recommended to others, not whether they get recommendations.
	 * Never runs automatically. Returns a summary of what was removed.
	 */
	@bindThis
	public async purgeBlockedUsers(): Promise<{ users: number; notesScanned: number; hqRemoved: number; featRemoved: number }> {
		const ids = [...await this.getBlockedAuthorIds()];
		if (ids.length === 0) return { users: 0, notesScanned: 0, hqRemoved: 0, featRemoved: 0 };

		// 1. Note vectors authored by these users (no-op when Milvus is disabled).
		await this.milvusService.deleteNoteVectorsByUsers(ids).catch(() => { /* best-effort */ });

		// 2. Author produce-centroids (both modalities).
		const centroidKeys = ids.flatMap(id => [`rec:avec:mm:${id}`, `rec:avec:txt:${id}`]);
		try { if (centroidKeys.length > 0) await this.redisForTimelines.del(...centroidKeys); } catch { /* best-effort */ }

		// 3. Scan their public notes within the feature-cache window; pull each out of the per-language
		// high-quality index and drop its cached feature blob. Keyset-paginated so memory stays bounded.
		const sinceId = this.idService.gen(Date.now() - FEATURE_TTL_SEC * 1000);
		let lastId: string | null = null;
		let notesScanned = 0;
		let hqRemoved = 0;
		let featRemoved = 0;
		for (;;) {
			const q = this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id').addSelect('note.lang', 'lang')
				.where('note.userId IN (:...ids)', { ids })
				.andWhere('note.id > :sinceId', { sinceId })
				.andWhere('note.visibility = \'public\'')
				.orderBy('note.id', 'ASC')
				.limit(1000);
			if (lastId != null) q.andWhere('note.id > :lastId', { lastId });

			const batch = await q.getRawMany<{ id: string; lang: string | null }>();
			if (batch.length === 0) break;

			const pipe = this.redisForTimelines.pipeline();
			const ops: ('hq' | 'feat')[] = [];
			for (const row of batch) {
				const lang = normalizeLang(row.lang);
				if (lang != null) { pipe.zrem(`rec:hq:${lang}`, row.id); ops.push('hq'); }
				pipe.del(`rec:feat:${row.id}`); ops.push('feat');
			}
			const res = await pipe.exec();
			if (res) {
				res.forEach(([, reply], i) => {
					if ((Number(reply) || 0) > 0) { if (ops[i] === 'hq') hqRemoved++; else featRemoved++; }
				});
			}
			notesScanned += batch.length;
			lastId = batch[batch.length - 1].id;
		}

		this.logger.info(`purge blocked users: ${ids.length} user(s), scanned ${notesScanned} notes, hq removed ${hqRemoved}, feat removed ${featRemoved}`);
		return { users: ids.length, notesScanned, hqRemoved, featRemoved };
	}
}
