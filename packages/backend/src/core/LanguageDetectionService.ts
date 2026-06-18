/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

// The head of the text is more than enough to detect a language; keep requests small/fast.
const MAX_SAMPLE_LENGTH = 2000;

/**
 * Detects the language of note text by calling the lingua-py sidecar (see /langdetect).
 * Detection is best-effort: any failure (sidecar down, timeout, bad payload) resolves to
 * null so it can never block note creation.
 */
@Injectable()
export class LanguageDetectionService {
	private logger: Logger;
	private readonly enabled: boolean;
	private readonly url: string;
	private readonly timeout: number;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private httpRequestService: HttpRequestService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('lang-detection');

		const conf = config.serviceServer;
		this.enabled = !!conf?.enabled;
		this.url = `http://${conf?.host ?? '127.0.0.1'}:${conf?.port ?? 3061}`;
		this.timeout = conf?.timeout ?? 3000;
	}

	@bindThis
	public async detectLanguage(text: string | null | undefined): Promise<string | null> {
		if (!this.enabled) return null;

		const trimmed = (text ?? '').trim();
		if (trimmed.length === 0) return null;

		const sample = trimmed.length > MAX_SAMPLE_LENGTH ? trimmed.slice(0, MAX_SAMPLE_LENGTH) : trimmed;

		try {
			// Plain fetch (not httpRequestService): the service server is a loopback address,
			// which the federation HTTP client blocks as a private network.
			const res = await fetch(`${this.url}/detect`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ text: sample }),
				signal: AbortSignal.timeout(this.timeout),
			});
			if (!res.ok) return null;

			const json = await res.json() as { lang?: string | null };
			if (json == null || typeof json.lang !== 'string' || json.lang === '') return null;

			// Normalize to a short ISO 639-1 code, matching the column width.
			return json.lang.toLowerCase().slice(0, 16);
		} catch (err) {
			this.logger.warn(`language detection failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}
}
