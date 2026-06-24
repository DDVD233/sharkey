/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { NotesRepository, UsersRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { EmbeddingService } from '@/core/EmbeddingService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { RecMediaService } from '@/core/RecMediaService.js';
import { RecommendationService } from '@/core/RecommendationService.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { EmbedNoteJobData } from '../types.js';

@Injectable()
export class EmbedNoteProcessorService {
	private logger: Logger;
	private readonly supportedLangs: Set<string>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private embeddingService: EmbeddingService,
		private milvusService: MilvusService,
		private recMediaService: RecMediaService,
		private recommendationService: RecommendationService,
		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('embed-note');
		this.supportedLangs = new Set((config.recommendation?.supportedLangs ?? ['zh', 'en', 'ja']).map(l => l.toLowerCase()));
	}

	@bindThis
	public async process(job: Bull.Job<EmbedNoteJobData>): Promise<void> {
		if (!this.embeddingService.enabled) return;

		// `force` = a local user explicitly engaged with this note, so we ALWAYS embed it (so their like
		// feeds their interest vector) — bypassing the quality / language / has-text gates that normally
		// keep the vector store small for discovery candidates.
		const force = job.data.force === true;

		const note = await this.notesRepository.findOneBy({ id: job.data.noteId });
		if (note == null) return;

		// Never embed non-public notes into the shared store (they could otherwise be recommended to
		// others), channel notes (not discovery content), or blocklisted authors — even when forced.
		if (note.visibility !== 'public') return;
		if (note.channelId != null) return;
		if (await this.recommendationService.isAuthorBlocked(note.userId)) return;

		// Only embed notes from EXPLORABLE (discoverable) authors. Excluding non-discoverable accounts at
		// INSERTION (rather than filtering them out at serve time) keeps the ANN store all-recommendable —
		// so every retrieved candidate is usable (no wasted top-K slots) and the serve path needs no
		// isExplorable filter. Applies even to forced embeds: nothing non-explorable ever enters Milvus.
		const author = await this.usersRepository.findOneBy({ id: note.userId });
		if (author == null || !author.isExplorable) return;

		const hasText = note.text != null && note.text.trim().length > 0;
		const lang = this.recommendationService.normalizeLang(note.lang);
		if (!force) {
			// Normal discovery embeds are limited to text-bearing, supported-language, not-low-quality notes.
			if (!hasText) return;
			if (lang == null || !this.supportedLangs.has(lang)) return;
			if (await this.recommendationService.isBelowRetrievalQuality(note.id)) return;
		}

		// Embed the whole post: its text plus its images (actually downloaded + downscaled, sent as
		// base64 — not as URLs). Notes WITH images become multimodal vectors and go to the 'mm'
		// collection; text-only notes go to 'txt'. The two are never mixed (different vector subspaces).
		// Quality scoring is a SEPARATE job (the 'score' queue), so it isn't done here.
		const images = await this.recMediaService.loadDownscaledImageDataUrls(note.fileIds);
		if (!hasText && images.length === 0) return; // nothing to embed
		const modality = images.length > 0 ? 'mm' as const : 'txt' as const;
		const vector = modality === 'mm'
			? await this.embeddingService.embedMultimodal(note.text, images)
			: await this.embeddingService.embedOne(note.text);
		// A transient failure resolves to null while enabled — throw so BullMQ retries with backoff.
		if (vector == null) throw new Error(`embedding returned no vector for note ${note.id}`);

		await this.milvusService.upsertNoteVectors([{
			noteId: note.id,
			vector,
			lang: lang ?? 'und', // forced embeds may carry an unsupported/unknown language
			userId: note.userId,
			createdAt: this.idService.parse(note.id).date.getTime(),
		}], modality);

		// Fold this note into its author's produce centroid (Tier A author-similarity prior). Runs for
		// every embedded public note, local or remote, so author centroids cover the whole candidate pool.
		await this.recommendationService.foldAuthorCentroid(note.userId, modality, vector);
	}
}
