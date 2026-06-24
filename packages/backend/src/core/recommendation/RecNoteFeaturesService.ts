/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, NotesRepository, NoteTopicsRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { LlmQualityService } from '@/core/LlmQualityService.js';
import { analyzeNoteText, structuralQuality } from '@/misc/note-quality.js';
import type { Topic } from '@/core/rec-topics.js';
import type Logger from '@/logger.js';
import { HQ_QUALITY_MIN, RETRIEVAL_QUALITY_MIN, HQ_WINDOW_MS, FEATURE_TTL_SEC } from './constants.js';
import { normalizeLang } from './lang.js';
import { llmTo01 } from './math.js';
import type { NoteFeatures } from './types.js';

@Injectable()
export class RecNoteFeaturesService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		@Inject(DI.noteTopicsRepository)
		private noteTopicsRepository: NoteTopicsRepository,
		@Inject(DI.config)
		private config: Config,
		private idService: IdService,
		private milvusService: MilvusService,
		private llmQualityService: LlmQualityService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Computes and caches a note's content features: the deterministic structural quality (always) and
	 * the LLM interestingness score (best-effort, 1-5). Runs on the 'score' queue. Idempotent: if the
	 * note is already scored it returns immediately, so re-enqueues (e.g. one per engagement) don't
	 * re-hit the LLM. Never throws — quality is optional. Quality is static per note; to re-score after a
	 * prompt change, clear the `rec:feat:{id}` key (the backfill also skips already-scored notes).
	 */
	@bindThis
	public async recordNoteFeatures(noteId: MiNote['id'], text: string | null, imageDataUrls: string[], lang?: string | null): Promise<void> {
		try {
			// Topic is classified once and persisted to `note_topic`, independent of the quality cache —
			// so a topic-only backfill over already-quality-scored notes adds topics without re-running the
			// quality LLM. Multimodal: uses the same downscaled images passed in for quality scoring.
			await this.recordNoteTopic(noteId, text ?? '', imageDataUrls);

			if (await this.redisForTimelines.exists(`rec:feat:${noteId}`)) return; // quality already scored
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
			// Evict the lowest-quality tier from the vector store so it can never be retrieved as an ANN
			// discovery candidate — UNLESS a local user engaged with it (rec:keep), in which case we always
			// keep it embedded so it still feeds their interest vector.
			if (q != null && q < RETRIEVAL_QUALITY_MIN && this.milvusService.enabled && !(await this.redisForTimelines.exists(`rec:keep:${noteId}`))) {
				await this.milvusService.deleteNoteVectors([noteId]);
			}
			// Index high-quality, recent notes per language so candidate generation can retrieve from a
			// quality-gated pool (the old global-trending source is gone). Only the LLM score counts here.
			await this.indexHighQuality(noteId, q, lang);
		} catch (err) {
			this.logger.warn(`recordNoteFeatures failed for ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Classifies a note's single topic (multimodal, best-effort) and persists it to `note_topic`.
	 * Idempotent: skips notes that already have a topic (so per-engagement re-enqueues don't re-hit the
	 * LLM). A null result means the request failed — we persist nothing and a later run retries; a
	 * successful-but-unrecognized output is mapped to the residual bucket inside classifyTopic, so it
	 * still persists and is never re-classified.
	 */
	@bindThis
	private async recordNoteTopic(noteId: MiNote['id'], text: string, imageDataUrls: string[]): Promise<void> {
		if (!this.llmQualityService.topicEnabled) return;
		if (await this.noteTopicsRepository.countBy({ noteId }) > 0) return; // already assigned
		const topic: Topic | null = await this.llmQualityService.classifyTopic(text, imageDataUrls);
		if (topic == null) return; // request failed — leave for a later retry
		// orIgnore: another worker may have inserted concurrently (PK conflict) — that's fine.
		await this.noteTopicsRepository.createQueryBuilder()
			.insert().values({ noteId, topic }).orIgnore().execute();
	}

	/**
	 * Adds a note to the per-language high-quality index (`rec:hq:{lang}` zset, member=noteId,
	 * score=note timestamp ms) when its LLM interestingness is ≥ HQ_QUALITY_MIN. Opportunistically
	 * trims entries older than the discovery window so retrieval never has to filter stale ids.
	 */
	@bindThis
	private async indexHighQuality(noteId: MiNote['id'], q: number | null, lang: string | null | undefined): Promise<void> {
		if (q == null || q < HQ_QUALITY_MIN) return;
		const nlang = normalizeLang(lang);
		if (nlang == null) return;
		const ts = this.idService.parse(noteId).date.getTime();
		const key = `rec:hq:${nlang}`;
		await this.redisForTimelines.multi()
			.zadd(key, ts, noteId)
			.zremrangebyscore(key, '-inf', Date.now() - HQ_WINDOW_MS)
			.expire(key, Math.ceil(HQ_WINDOW_MS / 1000) + 60 * 60 * 24)
			.exec();
	}

	/**
	 * Retrieves recent high-quality (LLM q≥HQ_QUALITY_MIN) note ids for the given languages, newest
	 * first, from the per-language index. This is the discovery candidate pool — for cold users it's the
	 * ENTIRE pool, so they're ranked over high-quality content only. Best-effort: empty on any error.
	 */
	@bindThis
	private async getHighQualityRecent(langs: string[], limit: number): Promise<string[]> {
		if (langs.length === 0) return [];
		try {
			const now = Date.now();
			const min = now - HQ_WINDOW_MS;
			const out: string[] = [];
			const pipe = this.redisForTimelines.pipeline();
			for (const lang of langs) pipe.zrevrangebyscore(`rec:hq:${lang}`, now, min, 'LIMIT', 0, limit);
			const res = await pipe.exec();
			if (res) for (const [, ids] of res) out.push(...((ids as string[] | null) ?? []));
			return out;
		} catch (err) {
			this.logger.warn(`getHighQualityRecent failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * One-off backfill of the high-quality index from already-scored notes: streams recent public
	 * supported-language notes (newest-first, last `days`), reads their cached features, and indexes any
	 * with LLM q≥HQ_QUALITY_MIN. Used to populate the index for notes scored before it existed.
	 */
	@bindThis
	public async backfillHighQualityIndex(days: number, limit: number, langs?: string[]): Promise<number> {
		const targetLangs = (langs ?? this.config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase());
		const sinceId = this.idService.gen(Date.now() - days * 24 * 60 * 60 * 1000);
		let lastId: string | null = null;
		let scanned = 0;
		let indexed = 0;
		this.logger.info(`hq index backfill started: days=${days} limit=${limit} langs=${targetLangs.join(',')}`);
		while (scanned < limit) {
			const take = Math.min(1000, limit - scanned);
			const q = this.notesRepository.createQueryBuilder('note')
				.select('note.id', 'id').addSelect('note.lang', 'lang')
				.where('note.id > :sinceId', { sinceId })
				.andWhere('note.visibility = \'public\'')
				.andWhere('note.channelId IS NULL')
				.andWhere('note.text IS NOT NULL')
				.andWhere('note.lang IN (:...langs)', { langs: targetLangs })
				.orderBy('note.id', 'DESC')
				.limit(take);
			if (lastId != null) q.andWhere('note.id < :lastId', { lastId });

			const batch = await q.getRawMany<{ id: string; lang: string | null }>();
			if (batch.length === 0) break;
			const feats = await this.redisForTimelines.mget(...batch.map(r => `rec:feat:${r.id}`));
			for (let i = 0; i < batch.length; i++) {
				const raw = feats[i];
				if (raw == null) continue;
				try {
					const f = JSON.parse(raw) as NoteFeatures;
					if (f.q != null && f.q >= HQ_QUALITY_MIN) {
						await this.indexHighQuality(batch[i].id, f.q, batch[i].lang);
						indexed++;
					}
				} catch { /* skip */ }
			}
			scanned += batch.length;
			lastId = batch[batch.length - 1].id;
			if (scanned % 20000 === 0) this.logger.info(`hq index backfill scanned ${scanned}, indexed ${indexed}…`);
		}
		this.logger.info(`hq index backfill done: scanned ${scanned}, indexed ${indexed}`);
		return indexed;
	}

	/** Loads cached features for the given notes (one pipelined read). Missing notes are absent. */
	@bindThis
	public async getNoteFeatures(noteIds: string[]): Promise<Map<string, NoteFeatures>> {
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
	public qualityOf(feat: NoteFeatures | undefined): number {
		if (feat == null) return 0;
		return feat.q != null ? llmTo01(feat.q) : feat.sq;
	}

	/**
	 * True if the note has already been LLM-scored at the lowest tier we keep out of the vector store
	 * (q < RETRIEVAL_QUALITY_MIN). Lets the embed job skip upserting it (handles the score-ran-first
	 * ordering and re-embeds), so a note evicted once never re-enters Milvus. False when unscored.
	 */
	@bindThis
	public async isBelowRetrievalQuality(noteId: MiNote['id']): Promise<boolean> {
		// A note a local user engaged with is always kept (rec:keep), so never report it as below-quality.
		if (await this.redisForTimelines.exists(`rec:keep:${noteId}`)) return false;
		const raw = await this.redisForTimelines.get(`rec:feat:${noteId}`);
		if (raw == null) return false;
		try { const f = JSON.parse(raw) as NoteFeatures; return f.q != null && f.q < RETRIEVAL_QUALITY_MIN; } catch { return false; }
	}

	/** Of the given notes, which carry an image attachment (i.e. live in the multimodal collection). */
	@bindThis
	public async getMultimodalNoteIds(noteIds: string[]): Promise<Set<string>> {
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

	/** Loads each note's assigned topic (from note_topic). Notes without a topic yet are simply absent. */
	@bindThis
	public async getCandidateTopics(noteIds: string[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (noteIds.length === 0) return out;
		try {
			const rows = await this.noteTopicsRepository.createQueryBuilder('t')
				.select('t.noteId', 'noteId').addSelect('t.topic', 'topic')
				.where('t.noteId IN (:...noteIds)', { noteIds })
				.getRawMany<{ noteId: string; topic: string }>();
			for (const r of rows) out.set(r.noteId, r.topic);
		} catch (err) {
			this.logger.warn(`getCandidateTopics failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return out;
	}
}
