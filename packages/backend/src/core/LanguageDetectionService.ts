/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiUser } from '@/models/User.js';
import type { NotesRepository, UsersRepository } from '@/models/_.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

// The head of the text is more than enough to detect a language; keep requests small/fast.
const MAX_SAMPLE_LENGTH = 2000;

// Languages that make up >95% of real posts here. lingua reports these with ~1.0 confidence
// (unique scripts) or, for English, a fat low-confidence tail on short text. Anything OUTSIDE
// this set is overwhelmingly a short-text misdetection (sw, yo, la, tl, sn, cy, …), so we
// distrust it much more aggressively. lingua already emits 'zh' for all Chinese variants.
const DEFAULT_TRUSTED_LANGS = ['zh', 'ja', 'en', 'es', 'ru'];

// CJK languages lingua confuses on short text (e.g. a Japanese "草"/"www" detected as zh with
// high confidence). When the author's inferred language is one of these and detection picked a
// *different* one, prefer the author's — confidence can't catch this since the misdetection is
// high-confidence.
const CJK_LANGS = new Set(['ja', 'zh', 'ko', 'yue', 'wuu', 'nan']);

// Calibrated on ~8k real notes: trusted<0.30 + untrusted<0.85 corrects ~12.5% of notes
// (skepticism prioritized). All overridable via config.langDetection.
const DEFAULT_MIN_CONFIDENCE = 0.30;
const DEFAULT_MIN_CONFIDENCE_UNTRUSTED = 0.85;
const DEFAULT_MIN_NOTES_FOR_INFERRED = 5;

// How many of the user's most recent notes to consider when inferring their language.
const INFERRED_LANG_WINDOW = 100;

/**
 * Resolve a note's stored language from a raw detection + the author's inferred language.
 *
 * IMPORTANT: this is the single source of truth for note-language resolution. The Python
 * backfill (service-server/lang_resolve.py) mirrors this exactly — keep them in sync.
 *
 *   - undetected text            -> the user's inferred language (may be null)
 *   - intra-CJK misdetection     -> the user's inferred language (confidence-independent)
 *   - confidence below threshold -> the user's inferred language, else keep the raw guess
 *     (threshold is low for trusted langs, high for everything else)
 */
export function resolveNoteLang(opts: {
	rawLang: string | null;
	confidence: number;
	userInferredLang: string | null;
	trustedLangs: ReadonlySet<string>;
	minConfidence: number;
	minConfidenceUntrusted: number;
	cjkCrossCorrect: boolean;
}): string | null {
	const { rawLang, confidence, userInferredLang, trustedLangs, minConfidence, minConfidenceUntrusted, cjkCrossCorrect } = opts;

	if (rawLang == null) return userInferredLang;

	if (cjkCrossCorrect && userInferredLang != null && userInferredLang !== rawLang
		&& CJK_LANGS.has(rawLang) && CJK_LANGS.has(userInferredLang)) {
		return userInferredLang;
	}

	const threshold = trustedLangs.has(rawLang) ? minConfidence : minConfidenceUntrusted;
	if (confidence < threshold) {
		return userInferredLang ?? rawLang;
	}

	return rawLang;
}

/**
 * Detects the language of note text by calling the lingua-py sidecar (see /langdetect).
 * Detection is best-effort: any failure (sidecar down, timeout, bad payload) resolves to
 * null so it can never block note creation.
 *
 * Also owns the per-user inferred language (majority of the user's recent notes), which is
 * used to correct low-confidence / untrusted / cross-CJK detections.
 */
@Injectable()
export class LanguageDetectionService {
	private logger: Logger;
	private readonly enabled: boolean;
	private readonly url: string;
	private readonly timeout: number;

	private readonly trustedLangs: ReadonlySet<string>;
	private readonly minConfidence: number;
	private readonly minConfidenceUntrusted: number;
	private readonly cjkCrossCorrect: boolean;
	private readonly minNotesForInferred: number;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private httpRequestService: HttpRequestService,
		private idService: IdService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('lang-detection');

		const conf = config.serviceServer;
		this.enabled = !!conf?.enabled;
		this.url = `http://${conf?.host ?? '127.0.0.1'}:${conf?.port ?? 3061}`;
		this.timeout = conf?.timeout ?? 3000;

		const ld = config.langDetection;
		this.trustedLangs = new Set((ld?.trustedLangs ?? DEFAULT_TRUSTED_LANGS).map(l => l.toLowerCase()));
		this.minConfidence = ld?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
		this.minConfidenceUntrusted = ld?.minConfidenceUntrusted ?? DEFAULT_MIN_CONFIDENCE_UNTRUSTED;
		this.cjkCrossCorrect = ld?.cjkCrossCorrect ?? true;
		this.minNotesForInferred = ld?.minNotesForInferred ?? DEFAULT_MIN_NOTES_FOR_INFERRED;
	}

	@bindThis
	public async detectLanguage(text: string | null | undefined): Promise<string | null> {
		return (await this.detectLanguageDetailed(text))?.lang ?? null;
	}

	/**
	 * Like detectLanguage, but also returns lingua's confidence (0..1) for the top language.
	 * Useful when a caller needs to gauge how reliable the detection is (e.g. short/ambiguous text).
	 */
	@bindThis
	public async detectLanguageDetailed(text: string | null | undefined): Promise<{ lang: string; confidence: number } | null> {
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

			const json = await res.json() as { lang?: string | null; confidence?: number | null };
			if (json == null || typeof json.lang !== 'string' || json.lang === '') return null;

			return {
				// Normalize to a short ISO 639-1 code, matching the column width.
				lang: json.lang.toLowerCase().slice(0, 16),
				confidence: typeof json.confidence === 'number' ? json.confidence : 0,
			};
		} catch (err) {
			this.logger.warn(`language detection failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/**
	 * Detect a note's language and resolve it against the author's inferred language (low-confidence
	 * / untrusted / cross-CJK detections fall back to it). The raw lingua call is best-effort; on
	 * failure we fall back to the user's inferred language.
	 */
	@bindThis
	public async resolveLanguageForNote(text: string | null | undefined, userInferredLang: string | null): Promise<string | null> {
		const detected = await this.detectLanguageDetailed(text);
		return resolveNoteLang({
			rawLang: detected?.lang ?? null,
			confidence: detected?.confidence ?? 0,
			userInferredLang,
			trustedLangs: this.trustedLangs,
			minConfidence: this.minConfidence,
			minConfidenceUntrusted: this.minConfidenceUntrusted,
			cjkCrossCorrect: this.cjkCrossCorrect,
		});
	}

	/**
	 * Compute a user's inferred language: the most frequent `lang` among their most recent
	 * INFERRED_LANG_WINDOW notes. Returns null when there is too little signal. Uses the
	 * (userId, id) index. Mirrored by service-server/backfill_user_lang.py.
	 */
	@bindThis
	public async computeInferredLang(userId: MiUser['id']): Promise<string | null> {
		// Majority lang over the user's most recent INFERRED_LANG_WINDOW classified notes.
		// Keyset on (userId, id) makes the inner scan cheap. Mirrored by backfill_user_lang.py.
		const rows = await this.notesRepository.query(
			`SELECT recent.lang AS lang, COUNT(*)::int AS cnt FROM (
				SELECT lang FROM note
				WHERE "userId" = $1 AND lang IS NOT NULL
				ORDER BY id DESC LIMIT ${INFERRED_LANG_WINDOW}
			) recent GROUP BY recent.lang ORDER BY cnt DESC LIMIT 1`,
			[userId],
		) as { lang: string; cnt: number }[];

		const top = rows[0];
		if (top == null || top.cnt < this.minNotesForInferred) return null;
		return top.lang;
	}

	/**
	 * Recompute and persist a user's inferred language. No-op when unchanged. Best-effort:
	 * callers fire-and-forget this so it never blocks note creation.
	 */
	@bindThis
	public async updateUserInferredLang(userId: MiUser['id']): Promise<string | null> {
		const lang = await this.computeInferredLang(userId);
		await this.usersRepository.createQueryBuilder()
			.update()
			.set({ inferredLang: lang })
			.where('id = :userId', { userId })
			.andWhere('"inferredLang" IS DISTINCT FROM :lang', { lang })
			.execute();
		return lang;
	}

	/**
	 * Nightly recompute: refresh inferred language for every user who has posted within the last
	 * `days` days. Reuses updateUserInferredLang per user so the result is identical to the
	 * on-create refresh and the backfill. Best-effort per user.
	 */
	@bindThis
	public async recomputeActiveUserInferredLangs(days = 2): Promise<number> {
		const sinceId = this.idService.gen(Date.now() - days * 24 * 60 * 60 * 1000);
		const rows = await this.notesRepository.createQueryBuilder('note')
			.select('note.userId', 'userId')
			.distinct(true)
			.where('note.id > :sinceId', { sinceId })
			.getRawMany<{ userId: string }>();

		let count = 0;
		for (const { userId } of rows) {
			try {
				await this.updateUserInferredLang(userId);
				count++;
			} catch (err) {
				this.logger.warn(`inferred-lang recompute for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		this.logger.info(`recomputed inferred language for ${count} active user(s)`);
		return count;
	}
}
