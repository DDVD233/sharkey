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
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { QueueService } from '@/core/QueueService.js';
import type Logger from '@/logger.js';
import { RecCandidateService } from './RecCandidateService.js';
import { RecInterestService } from './RecInterestService.js';
import { REPLY_WEIGHT, RENOTE_WEIGHT, FAVORITE_WEIGHT, REACTION_RARE_WEIGHT, REACTION_NORMAL_WEIGHT, ENGAGED_MAX, PUSHED_TTL_SEC, FOLLOW_SEED_MAX, FOLLOW_SEED_WEIGHT } from './constants.js';
import { normalizeLang } from './lang.js';

@Injectable()
export class RecBackfillService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		@Inject(DI.config)
		private config: Config,
		private idService: IdService,
		private milvusService: MilvusService,
		private queueService: QueueService,
		private recInterestService: RecInterestService,
		private recCandidateService: RecCandidateService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
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
				await this.queueService.createScoreNoteJob(batch[i].id);
				enqueued++;
			}
			scanned += batch.length;
			lastId = batch[batch.length - 1].id;
		}
		this.logger.info(`quality backfill done: scanned ${scanned}, enqueued ${enqueued} quality job(s)`);
		return enqueued;
	}

	/**
	 * Backfills topics for notes that have a Milvus vector but no topic yet: streams recent public
	 * supported-language notes (newest-first, last `days`), keeps only those present in Milvus (we never
	 * classify non-recommendable notes), and enqueues a score job for each. The score job classifies the
	 * topic reusing the cached quality, so it does NOT re-run quality scoring. Resumable — already-topiced
	 * notes are skipped via NOT EXISTS, so a re-run continues from where it left off.
	 */
	@bindThis
	public async backfillTopics(days: number, limit: number, langs?: string[]): Promise<number> {
		const targetLangs = (langs ?? this.config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase());
		const sinceId = this.idService.gen(Date.now() - days * 24 * 60 * 60 * 1000);
		let lastId: string | null = null;
		let scanned = 0;
		let enqueued = 0;
		this.logger.info(`topic backfill started: days=${days} limit=${limit} langs=${targetLangs.join(',')}`);
		while (enqueued < limit) {
			const q = this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id')
				.where('note.id > :sinceId', { sinceId })
				.andWhere('note.visibility = \'public\'')
				.andWhere('note.channelId IS NULL')
				.andWhere('note.text IS NOT NULL')
				.andWhere('note.lang IN (:...langs)', { langs: targetLangs })
				.andWhere('NOT EXISTS (SELECT 1 FROM note_topic t WHERE t."noteId" = note.id)')
				.orderBy('note.id', 'DESC')
				.limit(1000);
			if (lastId != null) q.andWhere('note.id < :lastId', { lastId });

			const batch = await q.getRawMany<{ id: string }>();
			if (batch.length === 0) break;
			scanned += batch.length;
			lastId = batch[batch.length - 1].id;

			// Only classify notes that actually have a vector (i.e. are recommendable); skip the rest.
			const present = this.milvusService.enabled
				? await this.milvusService.getExistingNoteIds(batch.map(r => r.id))
				: new Set(batch.map(r => r.id));
			for (const row of batch) {
				if (!present.has(row.id)) continue;
				await this.queueService.createScoreNoteJob(row.id);
				if (++enqueued >= limit) break;
			}
			if (scanned % 20000 === 0) this.logger.info(`topic backfill scanned ${scanned}, enqueued ${enqueued}…`);
		}
		this.logger.info(`topic backfill done: scanned ${scanned}, enqueued ${enqueued} score job(s)`);
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
		const followedSet = await this.recCandidateService.getFollowedSet(userId);
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
			const l = normalizeLang(langOf.get(noteId));
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
		await this.recInterestService.recomputeInterestVectors(userId);

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
}
