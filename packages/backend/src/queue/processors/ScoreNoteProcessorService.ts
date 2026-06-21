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
import { RecMediaService } from '@/core/RecMediaService.js';
import { RecommendationService } from '@/core/RecommendationService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { ScoreNoteJobData } from '../types.js';

/**
 * Computes a note's content-quality features (structural + best-effort LLM interestingness). Runs on
 * its own queue, separate from embedding, so it can be scaled independently: a high worker concurrency
 * lets the shared LLM batch many score requests at once. Best-effort — never blocks posting/serving.
 */
@Injectable()
export class ScoreNoteProcessorService {
	private logger: Logger;
	private readonly supportedLangs: Set<string>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private embeddingService: EmbeddingService,
		private recMediaService: RecMediaService,
		private recommendationService: RecommendationService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('score-note');
		this.supportedLangs = new Set((config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase()));
	}

	@bindThis
	public async process(job: Bull.Job<ScoreNoteJobData>): Promise<void> {
		// Gated by the same "is the recommendation system on?" flag as embedding.
		if (!this.embeddingService.enabled) return;

		const note = await this.notesRepository.findOneBy({ id: job.data.noteId });
		if (note == null) return;
		if (note.visibility !== 'public') return;
		if (note.text == null || note.text.trim().length === 0) return;
		const lang = this.recommendationService.normalizeLang(note.lang);
		if (lang == null || !this.supportedLangs.has(lang)) return;

		// Multimodal notes are scored on text + image together (same downscaled images the embed job
		// uses). recordNoteFeatures is best-effort and never throws.
		const images = await this.recMediaService.loadDownscaledImageDataUrls(note.fileIds);
		await this.recommendationService.recordNoteFeatures(note.id, note.text, images, lang);
	}
}
