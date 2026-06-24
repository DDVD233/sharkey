/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { MiUser, NotesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { MilvusService } from '@/core/MilvusService.js';
import type Logger from '@/logger.js';
import { FOLLOWED_RECENT_DAYS, FOLLOW_LANE_MAX } from './constants.js';
import { cosine } from './math.js';
import type { ScoredCandidate } from './types.js';

@Injectable()
export class RecFollowsService {
	private logger: Logger;

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
		private fanoutTimelineService: FanoutTimelineService,
		private idService: IdService,
		private milvusService: MilvusService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('recommendation');
	}

	/**
	 * Records notes the user just viewed in their HOME (following) timeline, so the rec feed's follows lane
	 * won't re-surface posts they've already scrolled past in their normal timeline. Bounded to the follows
	 * window ({@link FOLLOWED_RECENT_DAYS}) — older views don't matter because the lane never shows posts
	 * that old. Fire-and-forget; called from the home-timeline endpoint. Best-effort.
	 */
	@bindThis
	public async recordHomeTimelineViews(userId: MiUser['id'], noteIds: string[]): Promise<void> {
		if (noteIds.length === 0) return;
		try {
			const now = Date.now();
			const key = `rec:homeseen:${userId}`;
			const ttlSec = FOLLOWED_RECENT_DAYS * 24 * 60 * 60;
			const tx = this.redisForTimelines.multi();
			for (const id of noteIds) tx.zadd(key, now, id);
			tx.zremrangebyscore(key, '-inf', now - ttlSec * 1000);
			tx.expire(key, ttlSec);
			await tx.exec();
		} catch (err) {
			this.logger.warn(`recordHomeTimelineViews failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * The FOLLOWS LANE candidate ids: the latest posts from accounts the user follows, read straight from
	 * their home-timeline cache (the same fanned-out feed the home timeline serves), ≤
	 * {@link FOLLOWED_RECENT_DAYS} old and not already seen — excluding BOTH rec-feed impressions (`seen`)
	 * AND posts already viewed in the user's normal home timeline (`rec:homeseen`), so a follow is never
	 * shown twice across the two feeds. Newest-first. Added to the SAME scored candidate pool (so every
	 * factor is computed) and split back out post-ranking to be interleaved at the user's followedRatio.
	 */
	/**
	 * Resolves boosts (pure renotes) in the follows-lane home-timeline ids. A pure renote carries NO content
	 * of its own, so scoring the wrapper penalises an empty post (e.g. a boost of a long, high-quality note
	 * would get the short-post penalty and zero quality/relevance — the score reflects the boost ACTION, not
	 * the content). So we replace each boost with the note it boosts: it's then scored on the real content,
	 * multiple boosts of the same note collapse to ONE candidate (less boost crowding), and the original
	 * surfaces even though its author isn't followed. When the user has boosts OFF (`withRenotes` false) we
	 * DROP boosts entirely instead. Quotes (which have their own text/media) are left untouched. Best-effort.
	 */
	@bindThis
	public async resolveFollowRenotes(ids: string[], withRenotes: boolean): Promise<string[]> {
		if (ids.length === 0) return ids;
		let targetOf: Map<string, string>;
		try {
			const rows = await this.notesRepository.manager.query(
				`SELECT id, "renoteId" AS target FROM note WHERE id = ANY($1)
					AND "renoteId" IS NOT NULL AND text IS NULL AND cw IS NULL AND "replyId" IS NULL
					AND "hasPoll" = false AND COALESCE(array_length("fileIds", 1), 0) = 0`,
				[ids]) as { id: string; target: string }[];
			targetOf = new Map(rows.map(r => [r.id, r.target]));
		} catch (err) {
			this.logger.warn(`resolveFollowRenotes failed: ${err instanceof Error ? err.message : String(err)}`);
			return ids; // best-effort: fall back to the raw ids
		}
		if (targetOf.size === 0) return ids;

		const out: string[] = [];
		const added = new Set<string>();
		for (const id of ids) {
			const target = targetOf.get(id);
			if (target == null) { // original post or quote — keep as-is
				if (!added.has(id)) { added.add(id); out.push(id); }
			} else if (withRenotes) { // boost → the note it boosts (deduped, so repeated boosts collapse)
				if (!added.has(target)) { added.add(target); out.push(target); }
			} // else: boosts off → drop entirely
		}
		return out;
	}

	@bindThis
	public async getFollowHomeIds(userId: MiUser['id'], seen: Set<string>): Promise<string[]> {
		const sinceId = this.idService.gen(Date.now() - FOLLOWED_RECENT_DAYS * 24 * 60 * 60 * 1000);
		const [home, homeSeen] = await Promise.all([
			this.fanoutTimelineService.get(`homeTimeline:${userId}`), // newest-first
			this.redisForTimelines.zrange(`rec:homeseen:${userId}`, 0, -1),
		]);
		const seenAll = seen.size > 0 ? new Set([...seen, ...homeSeen]) : new Set(homeSeen);
		return home.filter(id => id > sinceId && !seenAll.has(id)).slice(0, FOLLOW_LANE_MAX);
	}

	/**
	 * Real note↔interest cosine for follows-lane notes, read from their stored vectors (they may sit outside
	 * the ANN topK, so their similarity wasn't computed during retrieval). Returns id → cosine for the notes
	 * that are embedded; the ranker falls back to the neutral default for any that aren't.
	 */
	@bindThis
	public async computeFollowSims(ids: string[], interest: { mm: number[] | null; txt: number[] | null }, mmIds: Set<string>): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		if (ids.length === 0) return out;
		const [vmm, vtxt] = await Promise.all([
			this.milvusService.getNoteVectors(ids, 'mm'),
			this.milvusService.getNoteVectors(ids, 'txt'),
		]);
		for (const id of ids) {
			const isMm = mmIds.has(id);
			const vec = isMm ? vmm.get(id) : vtxt.get(id);
			const iv = isMm ? interest.mm : interest.txt;
			if (vec && iv) out.set(id, cosine(iv, vec));
		}
		return out;
	}

	/**
	 * Interleaves the FOLLOWS LANE (newest-first) into the score-sorted DISCOVERY feed at `ratio` (0..0.9):
	 * at each position emit from whichever side is proportionally BEHIND its target share, so any prefix
	 * carries ≈`ratio` follows while both last, then the remaining side fills the tail. Nothing is dropped.
	 * `ratio` 0 or an empty lane → pure discovery.
	 */
	@bindThis
	public interleaveFollows(discovery: ScoredCandidate[], follows: ScoredCandidate[], ratio: number): ScoredCandidate[] {
		if (follows.length === 0 || ratio <= 0) return discovery;
		if (discovery.length === 0) return follows;
		// 100% follows: serve every follow first (score-ranked), then fall back to discovery only once
		// follows run out — supply caps the ratio, exactly like the other interleaves.
		if (ratio >= 1) return [...follows, ...discovery];

		const out: ScoredCandidate[] = [];
		let fi = 0;
		let di = 0;
		const fT = Math.max(1e-6, ratio);
		const dT = Math.max(1e-6, 1 - ratio);
		while (fi < follows.length || di < discovery.length) {
			if (di >= discovery.length) { out.push(follows[fi++]); continue; }
			if (fi >= follows.length) { out.push(discovery[di++]); continue; }
			if (fi / fT <= di / dT) out.push(follows[fi++]);
			else out.push(discovery[di++]);
		}
		return out;
	}

	/**
	 * Interleaves the two score-sorted modality streams toward `targetImageShare` (≈1:1), capped by
	 * supply. Each stream stays in its own score order, but at every position we emit from whichever
	 * modality is proportionally BEHIND its target — so any prefix of the result (the first batch, the
	 * next page, …) carries the target mix while both last, then the remaining modality fills the tail.
	 * This prevents the higher-scoring modality from clustering at the front (the old floor-of-total
	 * approach balanced the totals but front-loaded one modality). One modality present → unchanged.
	 */
	@bindThis
	private interleaveModalities(ranked: ScoredCandidate[], mmIds: Set<string>, targetImageShare: number): ScoredCandidate[] {
		const mm = ranked.filter(c => mmIds.has(c.noteId));
		const txt = ranked.filter(c => !mmIds.has(c.noteId));
		if (mm.length === 0 || txt.length === 0) return ranked; // only one modality present — nothing to balance

		const out: ScoredCandidate[] = [];
		let mi = 0;
		let ti = 0;
		const imgT = Math.max(1e-6, targetImageShare);
		const txtT = Math.max(1e-6, 1 - targetImageShare);
		while (mi < mm.length || ti < txt.length) {
			if (ti >= txt.length) { out.push(mm[mi++]); continue; }
			if (mi >= mm.length) { out.push(txt[ti++]); continue; }
			// Emit the modality that is furthest behind its target share so far (mi/imgT vs ti/txtT).
			if (mi / imgT <= ti / txtT) out.push(mm[mi++]);
			else out.push(txt[ti++]);
		}
		return out;
	}
}
