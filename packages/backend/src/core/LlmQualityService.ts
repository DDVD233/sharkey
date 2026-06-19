/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';

// The model only ever emits a single digit, so we never need more than a couple of tokens.
const MAX_TOKENS = 2;
const MAX_ATTEMPTS = 2;
// Cap the text we send: quality is judged on the gist, not the whole essay, and short prompts keep
// the per-note cost low.
const MAX_TEXT_CHARS = 4000;

/**
 * Scores the general-audience "interestingness" of a post (1-5) using the same admin-configured vLLM
 * that powers translation and (via the service server) spam detection — a Qwen3.5-VL model. The call
 * is multimodal: image posts are judged on text + image together, text posts on text alone.
 *
 * Best-effort by contract: any failure (model down, bad output, not configured) returns null and the
 * caller falls back to the deterministic structural score. It runs only in queue workers, so it never
 * touches the note-creation or serving hot paths.
 */
@Injectable()
export class LlmQualityService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('llm-quality');
	}

	// Scoring needs both the shared LLM endpoint AND an admin-configured prompt. The prompt deliberately
	// lives only in instance settings (the DB), never in source, so it isn't part of the public release.
	public get enabled(): boolean {
		return !!this.serverSettings.llmTranslateURL && !!this.serverSettings.llmQualityPrompt;
	}

	/**
	 * Returns an integer interestingness score 1-5, or null if scoring is unavailable/failed.
	 * `imageDataUrls` are base64 data URLs (already downloaded + downscaled by the caller).
	 */
	@bindThis
	public async scoreNote(text: string, imageDataUrls: string[]): Promise<number | null> {
		const baseUrl = this.serverSettings.llmTranslateURL;
		const systemPrompt = this.serverSettings.llmQualityPrompt;
		if (!baseUrl || !systemPrompt) return null;

		const trimmed = (text ?? '').slice(0, MAX_TEXT_CHARS);
		const instruction = `Rate this post's interestingness from 1 to 5 (single digit only):\n\n${trimmed}`;
		// Text-only posts send a plain string; image posts send a multimodal content array
		// (images first, then the text instruction).
		const userMessageContent = imageDataUrls.length > 0
			? [...imageDataUrls.map(url => ({ type: 'image_url', image_url: { url } })), { type: 'text', text: instruction }]
			: instruction;

		const endpoint = this.resolveLlmEndpoint(baseUrl);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, */*',
			...(this.serverSettings.llmTranslateKey ? { Authorization: `Bearer ${this.serverSettings.llmTranslateKey}` } : {}),
		};
		const requestBody = JSON.stringify({
			model: this.serverSettings.llmTranslateModel ?? '',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userMessageContent },
			],
			temperature: 0,
			max_tokens: MAX_TOKENS,
			stream: false,
			// Qwen3.5 is a reasoning model; disable thinking so it emits just the digit.
			chat_template_kwargs: { enable_thinking: false },
		});

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					headers,
					body: requestBody,
					signal: AbortSignal.timeout(this.serverSettings.translationTimeout),
				});
				if (!res.ok) throw new Error(`LLM server returned HTTP ${res.status}`);
				const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
				const raw = json.choices?.[0]?.message?.content ?? '';
				const score = this.parseScore(raw);
				if (score == null) throw new Error(`unparseable quality output: ${JSON.stringify(raw).slice(0, 64)}`);
				return score;
			} catch (e) {
				if (attempt >= MAX_ATTEMPTS) {
					this.logger.warn(`quality scoring failed: ${e instanceof Error ? e.message : String(e)}`);
					return null;
				}
				await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 1500)));
			}
		}
		return null;
	}

	/** Extracts the first 1-5 digit from the model output. */
	@bindThis
	private parseScore(raw: string): number | null {
		const m = raw.match(/[1-5]/);
		if (!m) return null;
		return Number(m[0]);
	}

	// Accept either a base URL or a full chat-completions URL and normalize to the OpenAI endpoint.
	@bindThis
	private resolveLlmEndpoint(url: string): string {
		const trimmed = url.replace(/\/+$/, '');
		if (/\/(chat\/completions|completions)$/.test(trimmed)) return trimmed;
		if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
		return `${trimmed}/v1/chat/completions`;
	}
}
