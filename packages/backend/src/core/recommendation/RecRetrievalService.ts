/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiNote, MiUser, NotesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { QueryService } from '@/core/QueryService.js';
import { CacheService } from '@/core/CacheService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import type Logger from '@/logger.js';
import { RecBlocklistService } from './RecBlocklistService.js';
import { BASE_SELECTED_LANG, CROSS_LANG_SHARE_MIDPOINT, CROSS_LANG_SHARE_TEMP, CROSS_LANG_SAMPLE_K, STRICT_LANG_MIN_AFFINITY } from './constants.js';

@Injectable()
export class RecRetrievalService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		private queryService: QueryService,
		private cacheService: CacheService,
		private recBlocklistService: RecBlocklistService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Effective per-language weights in [0,1]. The selected language always carries at least
	 * BASE_SELECTED_LANG; another language's weight rises along a smooth, conservative curve (logistic
	 * in like-share × sample confidence) so it only matters once the user overwhelmingly and
	 * significantly engages in it — never a hard switch.
	 */
	@bindThis
	public async getLangWeights(userId: MiUser['id'], selectedLangs: string[], restrictToSelected: boolean): Promise<{ weights: Map<string, number>; total: number }> {
		const weights = new Map<string, number>();
		const selected = new Set(selectedLangs);

		const aff = await this.redisForTimelines.hgetall(`rec:langaff:${userId}`);
		const entries = Object.entries(aff).map(([lang, v]) => [lang, Number(v) || 0] as const);
		const total = entries.reduce((s, [, v]) => s + v, 0);

		// Every selected language always carries at least the base weight (so explicitly-chosen languages
		// are never filtered out), rising up to its own like-share.
		for (const lang of selected) {
			const share = total > 0 ? (Number(aff[lang]) || 0) / total : 0;
			weights.set(lang, Math.min(1, Math.max(BASE_SELECTED_LANG, share)));
		}

		// When the user has NOT explicitly chosen languages, allow a single UI language to drift toward a
		// second language they overwhelmingly engage in. With an explicit multi-language selection we stay
		// strictly within it (the user asked for exactly these).
		if (!restrictToSelected && total > 0) {
			const sampleFactor = total / (total + CROSS_LANG_SAMPLE_K);
			for (const [lang, v] of entries) {
				if (selected.has(lang)) continue;
				const share = v / total;
				const shareFactor = 1 / (1 + Math.exp(-(share - CROSS_LANG_SHARE_MIDPOINT) / CROSS_LANG_SHARE_TEMP));
				const w = share * shareFactor * sampleFactor;
				if (w > 0.02) weights.set(lang, Math.min(1, w));
			}
		}
		return { weights, total };
	}

	/** Total weighted language-affinity signal — used to decide whether to trust the user's language. */
	@bindThis
	private async langAffinityTotal(userId: MiUser['id']): Promise<number> {
		const aff = await this.redisForTimelines.hgetall(`rec:langaff:${userId}`);
		return Object.values(aff).reduce((s, v) => s + (Number(v) || 0), 0);
	}

	/**
	 * Recent public matched-language notes ordered newest-first, excluding the given ids. Used as the
	 * never-empty tail of the feed. Once a user has a clear language signal we keep this strict to
	 * their language(s); for cold users (or anonymous) we also allow undetected-language notes so the
	 * feed isn't empty before any signal exists.
	 */
	@bindThis
	public async getRecentLangTail(meId: MiUser['id'] | null, langs: string[], excludeIds: string[], limit: number): Promise<string[]> {
		const allowNull = meId == null ? true : (await this.langAffinityTotal(meId)) < STRICT_LANG_MIN_AFFINITY;
		const langCond = langs.length === 0
			? '1=1'
			: allowNull ? '(note.lang IN (:...langs) OR note.lang IS NULL)' : 'note.lang IN (:...langs)';
		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.where('note.visibility = \'public\'')
			.andWhere('note.channelId IS NULL')
			.andWhere('user.isExplorable = TRUE')
			.andWhere(langCond, { langs })
			.orderBy('note.id', 'DESC')
			// Fetch extra headroom: the per-author cap below drops a prolific account's surplus, so we
			// need more rows than `limit` to still fill the page with diverse content.
			.limit(Math.min(1000, (limit + excludeIds.length) * 3));

		this.queryService.generateBlockedHostQueryForNote(query);
		const me = meId ? { id: meId } : null;
		this.queryService.generateVisibilityQuery(query, me);

		// Anti-streak: space the recency tail by author too (a high-volume account, e.g. a news mirror,
		// posts most-recently and would otherwise fill this fallback in a block). Lenient — not a cap,
		// just spacing — so a frequent poster still appears, spread out.
		const exclude = new Set(excludeIds);
		const rows = (await query.getMany()).filter(n => !exclude.has(n.id));
		const spaced = this.spaceByAuthor(rows, n => n.userId, () => false);
		return spaced.slice(0, limit).map(n => n.id);
	}

	/**
	 * Loads notes by id with the relations packMany needs, applying visibility/mute/block/host
	 * filtering. Result order is not guaranteed (callers reorder as needed).
	 */
	@bindThis
	public async loadAndFilterNotes(noteIds: string[], meId: MiUser['id'] | null, excludeSensitive = false, excludeRenotes = false): Promise<MiNote[]> {
		if (noteIds.length === 0) return [];

		// NB: no `isExplorable` filter here — non-discoverable authors are excluded at EMBED time, so the
		// ANN store (the dominant candidate source) is already all-recommendable. (getRecentLangTail keeps
		// its own isExplorable filter for the DB-sourced fallback tail.)
		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.id IN (:...noteIds)', { noteIds })
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser')
			.leftJoinAndSelect('note.channel', 'channel')
			.andWhere('note.channelId IS NULL');

		// NSFW filter: when the user (or anonymous default) hides sensitive content, drop any note that
		// carries a drive file flagged sensitive. CW text-only posts are unaffected (no sensitive media).
		if (excludeSensitive) {
			query.andWhere('NOT EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(note."fileIds") AND df."isSensitive" = true)');
		}

		// Boosts off: drop pure renotes (quotes, which have their own content, are kept). Serve-path
		// guarantee — the follows lane already resolves/drops boosts at build time, this catches any other.
		if (excludeRenotes) {
			this.queryService.generateExcludedRenotesQueryForNotes(query);
		}

		this.queryService.generateBlockedHostQueryForNote(query);
		const me = meId ? { id: meId } : null;
		this.queryService.generateVisibilityQuery(query, me);
		if (me) {
			this.queryService.generateMutedUserQueryForNotes(query, me);
			this.queryService.generateBlockedUserQueryForNotes(query, me);
		}

		const [muting, blocked, recBlockedAuthors] = await Promise.all([
			meId ? this.cacheService.userMutingsCache.fetch(meId) : Promise.resolve(new Set<string>()),
			meId ? this.cacheService.userBlockedCache.fetch(meId) : Promise.resolve(new Set<string>()),
			// Admin recommendation blocklist: applies to everyone, anonymous included.
			this.recBlocklistService.getBlockedAuthorIds(),
		]);

		return (await query.getMany()).filter(note => {
			// Drop notes authored by anyone on the recommendation blocklist (safety net for SQL-sourced
			// candidates and stale vectors — blocked authors are also never embedded/scored upstream).
			if (recBlockedAuthors.has(note.userId)) return false;
			if (meId && isUserRelated(note, blocked)) return false;
			if (meId && isUserRelated(note, muting)) return false;
			return true;
		});
	}

	/**
	 * Reorders items so no two consecutive entries share an author (anti-streak), otherwise preserving
	 * the input order. When the next item would repeat the previous author, the highest item from a
	 * different author is pulled up instead; if none exists (only that author remains), it's emitted.
	 * Thread continuations are allowed to stay adjacent. Does not drop anything — purely spacing.
	 */
	@bindThis
	private spaceByAuthor<T>(items: T[], authorOf: (t: T) => string | null, isThread: (t: T) => boolean): T[] {
		const out: T[] = [];
		const pending = items.slice();
		let lastAuthor: string | null = null;
		while (pending.length > 0) {
			let idx = 0;
			if (lastAuthor != null && !isThread(pending[0]) && authorOf(pending[0]) === lastAuthor) {
				const alt = pending.findIndex(t => isThread(t) || authorOf(t) !== lastAuthor);
				if (alt >= 0) idx = alt;
			}
			const pick = pending.splice(idx, 1)[0];
			out.push(pick);
			if (!isThread(pick)) lastAuthor = authorOf(pick);
		}
		return out;
	}

	@bindThis
	public reorder(notes: MiNote[], order: string[]): MiNote[] {
		const byId = new Map(notes.map(n => [n.id, n]));
		const out: MiNote[] = [];
		for (const id of order) {
			const n = byId.get(id);
			if (n) out.push(n);
		}
		return out;
	}
}
