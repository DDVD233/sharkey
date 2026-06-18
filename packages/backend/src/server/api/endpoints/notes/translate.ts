/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URLSearchParams } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { RoleService } from '@/core/RoleService.js';
import type { MiMeta, MiNote } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { CacheService } from '@/core/CacheService.js';
import { hasText } from '@/models/Note.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { ApiError } from '../../error.js';

// Default system prompt used for LLM translation when the admin has not configured one.
// The {{to}} placeholder is replaced with the target language name. The note text is sent as a
// separate user message (see fetchLlmTranslation), so this prompt has no {{text}} placeholder.
export const DEFAULT_LLM_TRANSLATE_PROMPT = `You are a professional {{to}} native translator specializing in social media posts (fediverse / Mastodon-style). Fluently translate the text into {{to}}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (proper nouns, code, @mentions, #hashtags, URLs), keep the original text.
5. This is casual social-media text. Correctly interpret internet slang, memes, abbreviations, clipped/shortened words and dialect, and render them naturally and idiomatically (e.g. Japanese net slang: 垢=account, 草/w/ｗｗ=lol, ガチ/クソ as intensifiers; clipped forms: ねむ←ねむい=sleepy, おは←おはよう=morning, がんば←がんばる=do my best, り←了解=got it). Translate the intended meaning and preserve the casual tone, not word-for-word.
6. Never leave source-language words untranslated or romanized (do not output romaji/pinyin); always express the meaning in {{to}}. Keep emoticons, kaomoji (e.g. (>_<), orz) and emoji as-is.`;

export const meta = {
	tags: ['notes'],

	requireCredential: 'optional',
	kind: 'read:account',
	requiredRolePolicy: 'canUseTranslator',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			sourceLang: { type: 'string', optional: true, nullable: false },
			text: { type: 'string', optional: true, nullable: false },
		},
	},

	errors: {
		unavailable: {
			message: 'Translate of notes unavailable.',
			code: 'UNAVAILABLE',
			id: '50a70314-2d8a-431b-b433-efa5cc56444c',
		},
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'bea9b03f-36e0-49c5-a4db-627a029f8971',
		},
		cannotTranslateInvisibleNote: {
			message: 'Cannot translate invisible note.',
			code: 'CANNOT_TRANSLATE_INVISIBLE_NOTE',
			id: 'ea29f2ca-c368-43b3-aaf1-5ac3e74bbe5d',
		},
		translationFailed: {
			message: 'Failed to translate note. Please try again later or contact an administrator for assistance.',
			code: 'TRANSLATION_FAILED',
			id: '4e7a1a4f-521c-4ba2-b10a-69e5e2987b2f',
		},
	},

	// 10 calls per 5 seconds
	limit: {
		duration: 1000 * 5,
		max: 10,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		targetLang: { type: 'string' },
	},
	required: ['noteId', 'targetLang'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		private noteEntityService: NoteEntityService,
		private getterService: GetterService,
		private httpRequestService: HttpRequestService,
		private roleService: RoleService,
		private readonly cacheService: CacheService,
		private readonly loggerService: ApiLoggerService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (!(await this.noteEntityService.isVisibleForMe(note, me?.id ?? null, { me }))) {
				throw new ApiError(meta.errors.cannotTranslateInvisibleNote);
			}

			if (!hasText(note)) {
				return {};
			}

			const canLlm = this.serverSettings.enableLlmTranslation && !!this.serverSettings.llmTranslateURL;
			const canDeeplFree = this.serverSettings.deeplFreeMode && !!this.serverSettings.deeplFreeInstance;
			const canDeepl = !!this.serverSettings.deeplAuthKey || canDeeplFree;
			const canLibre = !!this.serverSettings.libreTranslateURL;
			if (!canLlm && !canDeepl && !canLibre) throw new ApiError(meta.errors.unavailable);

			let targetLang = ps.targetLang;
			if (targetLang.includes('-')) targetLang = targetLang.split('-')[0];

			let response = await this.cacheService.getCachedTranslation(note, targetLang);
			if (!response) {
				this.loggerService.logger.debug(`Fetching new translation for note=${note.id} lang=${targetLang}`);
				response = await this.fetchTranslation(note, targetLang);
				if (!response) {
					throw new ApiError(meta.errors.translationFailed);
				}

				await this.cacheService.setCachedTranslation(note, targetLang, response);
			}
			return response;
		});
	}

	private async fetchTranslation(note: MiNote & { text: string }, targetLang: string) {
		// Load-bearing try/catch - removing this will shift indentation and cause ~80 lines of upstream merge conflicts
		try {
			// LLM (OpenAI-compatible) handling.
			// When enabled it is the *only* translation service - we never fall back to DeepL/LibreTranslate.
			if (this.serverSettings.enableLlmTranslation && this.serverSettings.llmTranslateURL) {
				return await this.fetchLlmTranslation(note, targetLang);
			}

			// Ignore deeplFreeInstance unless deeplFreeMode is set
			const deeplFreeInstance = this.serverSettings.deeplFreeMode ? this.serverSettings.deeplFreeInstance : null;

			// DeepL/DeepLX handling
			if (this.serverSettings.deeplAuthKey || deeplFreeInstance) {
				const params = new URLSearchParams();
				params.append('text', note.text);
				params.append('target_lang', targetLang);
				const headers: Record<string, string> = {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json, */*',
				};
				if (this.serverSettings.deeplAuthKey) headers['Authorization'] = `DeepL-Auth-Key ${this.serverSettings.deeplAuthKey}`;
				const endpoint = deeplFreeInstance ?? ( this.serverSettings.deeplIsPro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate' );

				const res = await this.httpRequestService.send(endpoint, {
					method: 'POST',
					headers,
					body: params.toString(),
					timeout: this.serverSettings.translationTimeout,
				});
				if (this.serverSettings.deeplAuthKey) {
					const json = (await res.json()) as {
						translations: {
							detected_source_language: string;
							text: string;
						}[];
					};

					return {
						sourceLang: json.translations[0].detected_source_language,
						text: json.translations[0].text,
					};
				} else {
					const json = (await res.json()) as {
						code: number,
						message: string,
						data: string,
						source_lang: string,
						target_lang: string,
						alternatives: string[],
					};

					const languageNames = new Intl.DisplayNames(['en'], {
						type: 'language',
					});

					return {
						sourceLang: languageNames.of(json.source_lang),
						text: json.data,
					};
				}
			}

			// LibreTranslate handling
			if (this.serverSettings.libreTranslateURL) {
				const res = await this.httpRequestService.send(this.serverSettings.libreTranslateURL, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Accept: 'application/json, */*',
					},
					body: JSON.stringify({
						q: note.text,
						source: 'auto',
						target: targetLang,
						format: 'text',
						api_key: this.serverSettings.libreTranslateKey ?? '',
					}),
					timeout: this.serverSettings.translationTimeout,
				});

				const json = (await res.json()) as {
					alternatives: string[],
					detectedLanguage: { [key: string]: string | number },
					translatedText: string,
				};

				const languageNames = new Intl.DisplayNames(['en'], {
					type: 'language',
				});

				return {
					sourceLang: languageNames.of(json.detectedLanguage.language as string),
					text: json.translatedText,
				};
			}
		} catch (e) {
			this.loggerService.logger.error('Unhandled error from translation API: ', { e });
		}

		return null;
	}

	private async fetchLlmTranslation(note: MiNote & { text: string }, targetLang: string) {
		const baseUrl = this.serverSettings.llmTranslateURL;
		if (!baseUrl) return null;

		try {
			const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
			// targetLang is already normalized to the primary subtag (e.g. "en") in the caller.
			const targetLangName = languageNames.of(targetLang) ?? targetLang;

			// System prompt from the configured template (or the bundled default), with {{to}}
			// substituted for the target language name.
			let systemPrompt = (this.serverSettings.llmTranslatePrompt ?? DEFAULT_LLM_TRANSLATE_PROMPT)
				.replace(/\{\{\s*to\s*\}\}/g, targetLangName);

			// Mask MFM custom-emoji shortcodes (e.g. :blobcat:). The model otherwise mangles them
			// when translating — notably turning the leading ASCII colon into a CJK fullwidth one
			// (：blobcat:) which breaks emoji rendering. Opaque ⟦En⟧ markers survive translation
			// intact; we restore the exact shortcodes afterwards. (Restoring is a no-op for any
			// non-emoji token that happened to match, since it's put back verbatim.)
			const emojiShortcodes: string[] = [];
			const maskedText = note.text.replace(/:[\w@.+-]+:/g, (m) => {
				const i = emojiShortcodes.length;
				emojiShortcodes.push(m);
				return `⟦E${i}⟧`;
			});
			if (emojiShortcodes.length > 0) {
				systemPrompt += '\n\nThe text may contain placeholder markers like ⟦E0⟧, ⟦E1⟧. Copy every such marker into your translation exactly and unchanged — do not translate, remove, or alter them.';
			}

			// The note text is sent as a separate user message, wrapped in a short instruction.
			const userPrompt = `Translate to ${targetLangName} (output translation only):\n\n${maskedText}`;

			// Use plain fetch (not httpRequestService): the LLM server is an admin-configured
			// endpoint that may be plain http and/or a private address, both of which the
			// federation HTTP client rejects.
			const res = await fetch(this.resolveLlmEndpoint(baseUrl), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json, */*',
					...(this.serverSettings.llmTranslateKey ? { Authorization: `Bearer ${this.serverSettings.llmTranslateKey}` } : {}),
				},
				body: JSON.stringify({
					model: this.serverSettings.llmTranslateModel ?? '',
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					temperature: 0.3,
					stream: false,
					// Qwen3.5 is a reasoning model; disable thinking so it returns only the translation
					// (otherwise the <think> block leaks into the output).
					chat_template_kwargs: { enable_thinking: false },
				}),
				signal: AbortSignal.timeout(this.serverSettings.translationTimeout),
			});

			const json = (await res.json()) as {
				choices: { message: { content: string } }[];
			};

			const rawText = json.choices?.[0]?.message?.content?.trim();
			if (!rawText) return null;

			// Restore the masked emoji shortcodes (⟦En⟧ → :shortcode:).
			let text = rawText;
			emojiShortcodes.forEach((shortcode, i) => {
				text = text.split(`⟦E${i}⟧`).join(shortcode);
			});

			// The LLM doesn't report a detected source language, so fall back to the language
			// detected at note-ingest time (if any) for the "translated from" label.
			const sourceLang = note.lang ? (languageNames.of(note.lang) ?? undefined) : undefined;

			return {
				sourceLang,
				text,
			};
		} catch (e) {
			this.loggerService.logger.error('Unhandled error from LLM translation API: ', { e });
			return null;
		}
	}

	// Accept either a base URL (https://host) or a full chat-completions URL and normalize to the OpenAI endpoint.
	private resolveLlmEndpoint(url: string): string {
		const trimmed = url.replace(/\/+$/, '');
		if (/\/(chat\/completions|completions)$/.test(trimmed)) return trimmed;
		if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
		return `${trimmed}/v1/chat/completions`;
	}
}
