/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { NotesRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { EmbeddingService } from '@/core/EmbeddingService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { QueueService } from '@/core/QueueService.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';

// How far back to look for notes that may have missed embedding (e.g. while the service was down).
const BACKFILL_WINDOW_MS = 1000 * 60 * 90; // 90 minutes
const DEFAULT_RETENTION_DAYS = 60; // purge note vectors older than ~2 months by default
const MAX_BACKFILL = 1000;

/**
 * Hourly safety net for the embedding pipeline: enqueues embed jobs for recent public notes (the
 * embed job is idempotent and re-checks language/visibility) and evicts vectors past the TTL so the
 * Milvus store stays bounded.
 */
@Injectable()
export class EmbeddingBackfillProcessorService {
	private logger: Logger;
	private readonly supportedLangs: string[];
	private readonly retentionMs: number;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private embeddingService: EmbeddingService,
		private milvusService: MilvusService,
		private queueService: QueueService,
		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('embedding-backfill');
		this.supportedLangs = (config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase());
		this.retentionMs = (config.recommendation?.vectorRetentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
	}

	@bindThis
	public async process(): Promise<void> {
		if (!this.embeddingService.enabled) return;

		const sinceId = this.idService.gen(Date.now() - BACKFILL_WINDOW_MS);
		const notes = await this.notesRepository.createQueryBuilder('note')
			.select('note.id', 'id')
			.where('note.id > :sinceId', { sinceId })
			.andWhere('note.visibility = \'public\'')
			.andWhere('note.channelId IS NULL')
			.andWhere('note.lang IN (:...langs)', { langs: this.supportedLangs })
			.andWhere('note.text IS NOT NULL')
			.orderBy('note.id', 'DESC')
			.limit(MAX_BACKFILL)
			.getRawMany<{ id: string }>();

		for (const note of notes) {
			await this.queueService.createEmbedNoteJob(note.id);
		}
		if (notes.length > 0) {
			this.logger.info(`enqueued ${notes.length} embed job(s) for backfill`);
		}

		await this.milvusService.deleteOldNoteVectors(Date.now() - this.retentionMs);
	}
}
