/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import sharp from 'sharp';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { NotesRepository, DriveFilesRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { EmbeddingService } from '@/core/EmbeddingService.js';
import { MilvusService } from '@/core/MilvusService.js';
import { RecommendationService } from '@/core/RecommendationService.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { EmbedNoteJobData } from '../types.js';

const MAX_IMAGES = 4; // cap multimodal payload per note
const IMAGE_MAX_DIM = 512; // downscale longest side to this before embedding
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 15000;

@Injectable()
export class EmbedNoteProcessorService {
	private logger: Logger;
	private readonly supportedLangs: Set<string>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private embeddingService: EmbeddingService,
		private milvusService: MilvusService,
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

		const note = await this.notesRepository.findOneBy({ id: job.data.noteId });
		if (note == null) return;

		// Only embed public, text-bearing notes in a supported language (other/null languages are
		// surfaced via the recency tail instead, keeping the vector store small).
		if (note.visibility !== 'public') return;
		if (note.text == null || note.text.trim().length === 0) return;
		const lang = this.recommendationService.normalizeLang(note.lang);
		if (lang == null || !this.supportedLangs.has(lang)) return;

		// Embed the whole post: its text plus its images (actually downloaded + downscaled, sent as
		// base64 — not as URLs). Notes WITH images become multimodal vectors and go to the 'mm'
		// collection; text-only notes go to 'txt'. The two are never mixed (different vector subspaces).
		// The same downscaled images are reused for quality scoring, so they're only downloaded once.
		const images = await this.loadImageDataUrls(note.fileIds);

		// qualityOnly jobs (quality backfill of already-embedded notes) skip the embedding step.
		if (!job.data.qualityOnly) {
			const modality = images.length > 0 ? 'mm' as const : 'txt' as const;
			const vector = modality === 'mm'
				? await this.embeddingService.embedMultimodal(note.text, images)
				: await this.embeddingService.embedOne(note.text);
			// A transient failure resolves to null while enabled — throw so BullMQ retries with backoff.
			if (vector == null) throw new Error(`embedding returned no vector for note ${note.id}`);

			await this.milvusService.upsertNoteVectors([{
				noteId: note.id,
				vector,
				lang,
				userId: note.userId,
				createdAt: this.idService.parse(note.id).date.getTime(),
			}], modality);
		}

		// Content-quality features (structural + best-effort LLM interestingness). Never throws, and is
		// independent of the embedding above so a quality-service outage can't fail the embed job.
		await this.recommendationService.recordNoteFeatures(note.id, note.text, images);
	}

	/**
	 * Downloads up to MAX_IMAGES of the note's image attachments, downscales each to <= IMAGE_MAX_DIM,
	 * and returns them as base64 JPEG data URLs. Everything is processed in memory (nothing persisted),
	 * so there's no temp file to clean up. Failures per-image are skipped silently.
	 */
	@bindThis
	private async loadImageDataUrls(fileIds: string[]): Promise<string[]> {
		if (!fileIds || fileIds.length === 0) return [];
		const files = await this.driveFilesRepository.findBy({ id: In(fileIds) });
		const images = files.filter(f => f.type.startsWith('image/')).slice(0, MAX_IMAGES);

		const out: string[] = [];
		for (const file of images) {
			// Prefer the (already small) thumbnail served by this instance; fall back to the full file.
			const url = file.thumbnailUrl ?? file.webpublicUrl ?? file.url;
			if (!url) continue;
			try {
				const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
				if (!res.ok) continue;
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length === 0 || buf.length > MAX_DOWNLOAD_BYTES) continue;
				const resized = await sharp(buf, { failOn: 'none' })
					.resize(IMAGE_MAX_DIM, IMAGE_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
					.jpeg({ quality: 80 })
					.toBuffer();
				out.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
			} catch (err) {
				this.logger.warn(`image fetch/resize failed (${file.id}): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return out;
	}
}
