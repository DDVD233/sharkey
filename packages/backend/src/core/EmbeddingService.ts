/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

// Qwen3-VL-Embedding accepts up to 8192 tokens. We approximate a token budget with a
// character cap (~4 chars/token, kept conservative) so a single oversized note can never
// blow the request. The head of a note carries more than enough signal for recommendations.
const MAX_SAMPLE_LENGTH = 8000;

/**
 * Embeds note text via an OpenAI-compatible `/v1/embeddings` endpoint (the Qwen3-VL embedding
 * vLLM service). Best-effort: any failure (service down, timeout, bad payload) resolves to nulls
 * so it can never block note creation. The durable retry lives in the BullMQ embedding job; this
 * service does at most one short in-call retry.
 */
@Injectable()
export class EmbeddingService {
	private logger: Logger;
	private readonly enabledFlag: boolean;
	private readonly url: string | null;
	private readonly model: string;
	private readonly dim: number;
	private readonly timeout: number;

	constructor(
		@Inject(DI.config)
		private config: Config,

		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('embedding');

		const conf = config.recommendation;
		this.enabledFlag = !!conf?.enabled && !!conf?.embeddingUrl;
		this.url = conf?.embeddingUrl ?? null;
		this.model = conf?.embeddingModel ?? 'Qwen/Qwen3-VL-Embedding-2B';
		this.dim = conf?.embeddingDim ?? 2048;
		this.timeout = conf?.embeddingTimeout ?? 30000;
	}

	public get enabled(): boolean {
		return this.enabledFlag;
	}

	public get dimension(): number {
		return this.dim;
	}

	/**
	 * Embeds a batch of texts. Returns an array aligned with the input; entries are `null` when a
	 * text was empty or the whole request failed. Never throws.
	 */
	@bindThis
	public async embed(texts: (string | null | undefined)[]): Promise<(number[] | null)[]> {
		if (!this.enabledFlag || this.url == null) return texts.map(() => null);

		// Track which inputs are non-empty so we only send those and can map results back.
		const samples: string[] = [];
		const sampleIndexForInput: (number | null)[] = [];
		for (const text of texts) {
			const trimmed = (text ?? '').trim();
			if (trimmed.length === 0) {
				sampleIndexForInput.push(null);
				continue;
			}
			sampleIndexForInput.push(samples.length);
			samples.push(trimmed.length > MAX_SAMPLE_LENGTH ? trimmed.slice(0, MAX_SAMPLE_LENGTH) : trimmed);
		}

		if (samples.length === 0) return texts.map(() => null);

		const vectors = await this.requestWithRetry(samples);
		if (vectors == null) return texts.map(() => null);

		return sampleIndexForInput.map(i => (i == null ? null : (vectors[i] ?? null)));
	}

	/**
	 * Convenience for embedding a single text.
	 */
	@bindThis
	public async embedOne(text: string | null | undefined): Promise<number[] | null> {
		const [vec] = await this.embed([text]);
		return vec ?? null;
	}

	/**
	 * Embeds a single note multimodally: the note text plus one or more images (as base64 data URLs).
	 * Uses the chat `messages` format the embedding server accepts for vision input. Best-effort:
	 * returns null on failure. `imageDataUrls` are the actual downscaled image bytes — never remote URLs.
	 */
	@bindThis
	public async embedMultimodal(text: string | null | undefined, imageDataUrls: string[]): Promise<number[] | null> {
		if (!this.enabledFlag || this.url == null) return null;
		if (imageDataUrls.length === 0) return this.embedOne(text);

		const sample = (text ?? '').trim().slice(0, MAX_SAMPLE_LENGTH);
		const content: object[] = imageDataUrls.map(url => ({ type: 'image_url', image_url: { url } }));
		if (sample.length > 0) content.push({ type: 'text', text: sample });

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await fetch(this.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content }] }),
					signal: AbortSignal.timeout(this.timeout),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json() as { data?: { embedding?: number[] }[] };
				const vec = json?.data?.[0]?.embedding;
				return Array.isArray(vec) ? vec : null;
			} catch (err) {
				this.logger.warn(`multimodal embedding failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
				if (attempt === 1) return null;
			}
		}
		return null;
	}

	@bindThis
	private async requestWithRetry(inputs: string[]): Promise<(number[] | null)[] | null> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await this.request(inputs);
			} catch (err) {
				const last = attempt === 1;
				this.logger.warn(`embedding request failed (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
				if (last) return null;
			}
		}
		return null;
	}

	@bindThis
	private async request(inputs: string[]): Promise<(number[] | null)[]> {
		// Plain fetch: the embedding service is an explicit external/loopback host, which the
		// federation HTTP client would block as a private network.
		const res = await fetch(this.url!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ model: this.model, input: inputs }),
			signal: AbortSignal.timeout(this.timeout),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const json = await res.json() as { data?: { index?: number; embedding?: number[] }[] };
		const data = json?.data;
		if (!Array.isArray(data)) throw new Error('malformed response');

		// OpenAI-compatible responses carry an `index` per item; map defensively in case order differs.
		const out: (number[] | null)[] = new Array<number[] | null>(inputs.length).fill(null);
		for (let i = 0; i < data.length; i++) {
			const item: { index?: number; embedding?: number[] } = data[i];
			const idx = typeof item.index === 'number' ? item.index : i;
			if (Array.isArray(item.embedding) && idx >= 0 && idx < out.length) {
				out[idx] = item.embedding;
			}
		}
		return out;
	}
}
