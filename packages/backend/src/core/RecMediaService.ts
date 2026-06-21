/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import sharp from 'sharp';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { LoggerService } from '@/core/LoggerService.js';

const MAX_IMAGES = 4; // cap multimodal payload per note
const IMAGE_MAX_DIM = 512; // downscale longest side to this
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = 15000;

/**
 * Downloads a note's image attachments and returns them as downscaled base64 JPEG data URLs. Shared
 * by the embed and score queues (both need the same images for the multimodal model calls), so the
 * download/resize logic lives in one place. Everything is in memory — nothing is persisted.
 */
@Injectable()
export class RecMediaService {
	private logger: Logger;

	constructor(
		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('rec-media');
	}

	/**
	 * Downloads up to MAX_IMAGES of the given files' images, downscales each to <= IMAGE_MAX_DIM, and
	 * returns them as base64 JPEG data URLs. Failures per-image are skipped silently.
	 */
	@bindThis
	public async loadDownscaledImageDataUrls(fileIds: string[]): Promise<string[]> {
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
