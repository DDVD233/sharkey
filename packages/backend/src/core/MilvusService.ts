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

export type Modality = 'mm' | 'txt';

export type NoteVectorRow = {
	noteId: string;
	vector: number[];
	lang: string;
	userId: string;
	createdAt: number;
};

export type AnnHit = {
	noteId: string;
	score: number;
};

export type UserAnnHit = {
	userId: string;
	score: number;
};

/**
 * Vector store for content-based recommendation retrieval, backed by Milvus's HTTP/REST v2 API.
 * Multimodal (image+text) and text-only embeddings occupy different regions of the space, so they
 * live in SEPARATE collections and are only ever matched within their own modality:
 *  - `${prefix}note_vectors_mm`  — notes embedded with their images (multimodal)
 *  - `${prefix}note_vectors_txt` — text-only notes
 * User interest vectors live primarily in Redis (one per modality), but a copy is ALSO mirrored into
 * per-modality `${prefix}user_vectors_{mm,txt}` collections so we can do user→user ANN ("find people
 * with a similar interest vector") for collaborative-filtering retrieval. That mirror is refreshed on
 * the batch vector recompute, not on every engagement, so taste-neighbour lookups lag by ≤ a day.
 *
 * All operations are best-effort — when Milvus is disabled/unreachable, reads return empty and
 * writes are dropped, so the recommender degrades to popularity rather than failing.
 */
@Injectable()
export class MilvusService {
	private logger: Logger;
	private readonly enabledFlag: boolean;
	private readonly baseUrl: string | null;
	private readonly token: string | undefined;
	private readonly dim: number;
	private readonly collections: Record<Modality, string>;
	private readonly userCollections: Record<Modality, string>;
	private readonly authorCollections: Record<Modality, string>;
	private ready: Promise<boolean> | null = null;

	constructor(
		@Inject(DI.config)
		private config: Config,

		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('milvus');

		const conf = config.recommendation;
		this.enabledFlag = !!conf?.enabled && !!conf?.milvusUrl;
		this.baseUrl = conf?.milvusUrl ? `${conf.milvusUrl.replace(/\/$/, '')}/v2/vectordb` : null;
		this.token = conf?.milvusToken;
		this.dim = conf?.embeddingDim ?? 2048;
		const prefix = conf?.milvusCollectionPrefix ?? 'sharkey_rec_';
		this.collections = { mm: `${prefix}note_vectors_mm`, txt: `${prefix}note_vectors_txt` };
		this.userCollections = { mm: `${prefix}user_vectors_mm`, txt: `${prefix}user_vectors_txt` };
		// Durable per-author produce-centroids (the "author affinity" prior). A separate collection so it's
		// NOT subject to the note-vector retention — author centroids persist and accumulate over time.
		this.authorCollections = { mm: `${prefix}author_vectors_mm`, txt: `${prefix}author_vectors_txt` };
	}

	public get enabled(): boolean {
		return this.enabledFlag;
	}

	@bindThis
	private async rpc<T = unknown>(path: string, body: object): Promise<T> {
		const res = await fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20000),
		});
		if (!res.ok) throw new Error(`Milvus HTTP ${res.status}`);
		const json = await res.json() as { code?: number; message?: string; data?: T };
		if (json.code !== 0 && json.code !== 200) throw new Error(`Milvus error ${json.code}: ${json.message ?? ''}`);
		return json.data as T;
	}

	@bindThis
	private async ensureReady(): Promise<boolean> {
		if (!this.enabledFlag || this.baseUrl == null) return false;
		if (this.ready == null) {
			this.ready = this.ensureCollections().catch(err => {
				this.logger.error(`failed to initialise Milvus collections: ${err instanceof Error ? err.message : String(err)}`);
				this.ready = null; // allow a later retry
				return false;
			});
		}
		return this.ready;
	}

	@bindThis
	private async ensureCollections(): Promise<boolean> {
		const existing = await this.rpc<string[]>('/collections/list', {});
		const have = new Set(existing ?? []);
		for (const name of Object.values(this.collections)) {
			if (!have.has(name)) {
				await this.rpc('/collections/create', {
					collectionName: name,
					schema: {
						autoId: false, enableDynamicField: false, fields: [
							{ fieldName: 'noteId', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: '32' } },
							{ fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(this.dim) } },
							{ fieldName: 'lang', dataType: 'VarChar', elementTypeParams: { max_length: '16' } },
							{ fieldName: 'userId', dataType: 'VarChar', elementTypeParams: { max_length: '32' } },
							{ fieldName: 'createdAt', dataType: 'Int64' },
						],
					},
					// Explicit graph index (HNSW + SQ8). AUTOINDEX was observed to never finish building on this
					// Milvus deployment, leaving searches to brute-force over unindexed segments and time out.
					// HNSW is the right family here: candidate topK (~1000) is well under the ~1% of the collection
					// where IVF wins, and these are coarse candidates re-ranked in-app, so SQ8's small recall loss
					// is irrelevant while it cuts index memory ~75%.
					indexParams: [{
						fieldName: 'vector', indexName: 'vector_idx', metricType: 'COSINE', indexType: 'HNSW_SQ',
						params: { M: 16, efConstruction: 200, sq_type: 'SQ8' },
					}],
				});
			}
		}
		// User-vector collections for collaborative-filtering neighbour search. Same index family as
		// notes; keyed by userId, with an updatedAt for TTL eviction of long-inactive users.
		for (const name of Object.values(this.userCollections)) {
			if (!have.has(name)) {
				await this.rpc('/collections/create', {
					collectionName: name,
					schema: {
						autoId: false, enableDynamicField: false, fields: [
							{ fieldName: 'userId', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: '32' } },
							{ fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(this.dim) } },
							{ fieldName: 'updatedAt', dataType: 'Int64' },
						],
					},
					indexParams: [{
						fieldName: 'vector', indexName: 'vector_idx', metricType: 'COSINE', indexType: 'HNSW_SQ',
						params: { M: 16, efConstruction: 200, sq_type: 'SQ8' },
					}],
				});
			}
		}
		// Durable author produce-centroid collections (the author-affinity prior). Keyed by userId, with a
		// noteCount of how many of the author's notes are folded in. Read by id at rank time (no ANN needed),
		// but indexed like the others so the collection can still be loaded.
		for (const name of Object.values(this.authorCollections)) {
			if (!have.has(name)) {
				await this.rpc('/collections/create', {
					collectionName: name,
					schema: {
						autoId: false, enableDynamicField: false, fields: [
							{ fieldName: 'userId', dataType: 'VarChar', isPrimary: true, elementTypeParams: { max_length: '32' } },
							{ fieldName: 'vector', dataType: 'FloatVector', elementTypeParams: { dim: String(this.dim) } },
							{ fieldName: 'noteCount', dataType: 'Int64' },
						],
					},
					indexParams: [{
						fieldName: 'vector', indexName: 'vector_idx', metricType: 'COSINE', indexType: 'HNSW_SQ',
						params: { M: 16, efConstruction: 200, sq_type: 'SQ8' },
					}],
				});
			}
		}
		return true;
	}

	@bindThis
	public async upsertNoteVectors(rows: NoteVectorRow[], modality: Modality): Promise<void> {
		if (rows.length === 0) return;
		if (!await this.ensureReady()) return;
		try {
			await this.rpc('/entities/upsert', {
				collectionName: this.collections[modality],
				data: rows.map(r => ({ noteId: r.noteId, vector: r.vector, lang: r.lang, userId: r.userId, createdAt: r.createdAt })),
			});
		} catch (err) {
			this.logger.warn(`upsertNoteVectors failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * ANN search within one modality's collection. `langs` restricts to matching note languages
	 * (already normalized, e.g. ['zh']); empty means no restriction. `excludeIds` (e.g. already-seen
	 * notes) are filtered out DURING the search via `noteId not in [...]`, so the returned topK are all
	 * eligible — far better than retrieving topK and discarding seen ones afterward (which leaves only the
	 * worse-similarity tail). Milvus hashes the term list, so the exclusion is O(1) per entity even for
	 * thousands of ids. Ordered by descending similarity.
	 */
	@bindThis
	public async searchByVector(vector: number[], topK: number, langs: string[], modality: Modality, excludeIds: string[] = [], excludeAuthorIds: string[] = []): Promise<AnnHit[]> {
		if (!await this.ensureReady()) return [];
		const clauses: string[] = [];
		if (langs.length > 0) clauses.push(`lang in [${langs.map(l => `"${l.replace(/"/g, '')}"`).join(', ')}]`);
		if (excludeIds.length > 0) clauses.push(`noteId not in [${excludeIds.map(id => `"${id.replace(/"/g, '')}"`).join(',')}]`);
		// Author exclusion (muted / blocked / admin-blocklisted) — applied HERE at retrieval so those authors
		// never occupy a top-K slot, rather than being discarded after scoring.
		if (excludeAuthorIds.length > 0) clauses.push(`userId not in [${excludeAuthorIds.map(id => `"${id.replace(/"/g, '')}"`).join(',')}]`);
		const filter = clauses.length > 0 ? clauses.join(' && ') : undefined;
		// Plain (ungrouped) ANN: returns the true topK nearest, in descending similarity. We deliberately
		// do NOT use Milvus grouping search here — it roughly doubled query latency AND inflated the result
		// set to up to topK×groupSize hits (a much larger candidate pool to load+score downstream). Per-author
		// diversity is instead enforced app-side by the feed's spacing pass (`spaceByAuthor`), which already
		// guarantees no two consecutive notes share an author — so grouping bought no diversity the feed
		// didn't already provide, at significant cost.
		const body: Record<string, unknown> = {
			collectionName: this.collections[modality],
			data: [vector],
			annsField: 'vector',
			limit: topK,
			outputFields: ['noteId'],
			// HNSW requires the search beam `ef` to be ≥ the requested topK; give it modest headroom for
			// recall. Without this, large-topK searches can under-return or error on some Milvus versions.
			searchParams: { params: { ef: Math.ceil(topK * 1.2) } },
			...(filter ? { filter } : {}),
		};
		try {
			const data = await this.rpc<{ noteId?: string; distance?: number }[]>('/entities/search', body);
			return (data ?? [])
				.filter((r): r is { noteId: string; distance?: number } => typeof r.noteId === 'string')
				.map(r => ({ noteId: r.noteId, score: typeof r.distance === 'number' ? r.distance : 0 }));
		} catch (err) {
			this.logger.warn(`searchByVector failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * Mirrors a user's interest vector into the per-modality user collection so other users can find
	 * them as a taste-neighbour. Called from the batch vector recompute (not the per-engagement EMA),
	 * so these lag the Redis vectors by up to the recompute interval — fine, taste is slow-moving.
	 */
	@bindThis
	public async upsertUserVector(userId: string, vector: number[], modality: Modality): Promise<void> {
		if (!await this.ensureReady()) return;
		try {
			await this.rpc('/entities/upsert', {
				collectionName: this.userCollections[modality],
				data: [{ userId, vector, updatedAt: Date.now() }],
			});
		} catch (err) {
			this.logger.warn(`upsertUserVector failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Writes/overwrites an author's durable produce-centroid (+ how many of their notes it folds in). */
	@bindThis
	public async upsertAuthorVector(userId: string, vector: number[], noteCount: number, modality: Modality): Promise<void> {
		if (!await this.ensureReady()) return;
		try {
			await this.rpc('/entities/upsert', {
				collectionName: this.authorCollections[modality],
				data: [{ userId, vector, noteCount }],
			});
		} catch (err) {
			this.logger.warn(`upsertAuthorVector failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Reads author produce-centroids by id (the author-affinity prior at rank time). */
	@bindThis
	public async getAuthorVectors(userIds: string[], modality: Modality): Promise<Map<string, { v: number[]; n: number }>> {
		const out = new Map<string, { v: number[]; n: number }>();
		if (userIds.length === 0) return out;
		if (!await this.ensureReady()) return out;
		try {
			const ids = [...new Set(userIds)].map(id => `"${id.replace(/"/g, '')}"`).join(', ');
			const data = await this.rpc<{ userId?: string; vector?: number[]; noteCount?: number }[]>('/entities/query', {
				collectionName: this.authorCollections[modality],
				filter: `userId in [${ids}]`,
				outputFields: ['userId', 'vector', 'noteCount'],
				limit: userIds.length,
			});
			for (const row of data ?? []) {
				if (typeof row.userId === 'string' && Array.isArray(row.vector)) out.set(row.userId, { v: row.vector, n: Number(row.noteCount) || 0 });
			}
		} catch (err) {
			this.logger.warn(`getAuthorVectors failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return out;
	}

	/** All of an author's note vectors currently in the store (used to compute their centroid from their
	 * whole available history when one doesn't exist yet). Capped at `limit` most-recent. */
	@bindThis
	public async getAuthorNoteVectors(authorId: string, modality: Modality, limit: number): Promise<number[][]> {
		if (!await this.ensureReady()) return [];
		try {
			const data = await this.rpc<{ vector?: number[] }[]>('/entities/query', {
				collectionName: this.collections[modality],
				filter: `userId == "${authorId.replace(/"/g, '')}"`,
				outputFields: ['vector'],
				limit,
			});
			return (data ?? []).map(r => r.vector).filter((v): v is number[] => Array.isArray(v));
		} catch (err) {
			this.logger.warn(`getAuthorNoteVectors failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * Finds the users whose interest vector is most similar to `vector` within one modality (the
	 * collaborative-filtering neighbour query). Returns up to `topK` {userId, score} ordered by
	 * descending similarity; the caller is responsible for excluding the querying user themselves.
	 */
	@bindThis
	public async searchUsersByVector(vector: number[], topK: number, modality: Modality): Promise<UserAnnHit[]> {
		if (!await this.ensureReady()) return [];
		try {
			const data = await this.rpc<{ userId?: string; distance?: number }[]>('/entities/search', {
				collectionName: this.userCollections[modality],
				data: [vector],
				annsField: 'vector',
				limit: topK,
				outputFields: ['userId'],
				searchParams: { params: { ef: Math.ceil(topK * 1.2) } },
			});
			return (data ?? [])
				.filter((r): r is { userId: string; distance?: number } => typeof r.userId === 'string')
				.map(r => ({ userId: r.userId, score: typeof r.distance === 'number' ? r.distance : 0 }));
		} catch (err) {
			this.logger.warn(`searchUsersByVector failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	/**
	 * Fetches stored vectors for the given note ids from one modality's collection.
	 * Returns a map of noteId -> vector; notes not in that collection are simply absent (which also
	 * tells the caller a note's modality — it lives in exactly one collection).
	 */
	@bindThis
	public async getNoteVectors(noteIds: string[], modality: Modality): Promise<Map<string, number[]>> {
		const out = new Map<string, number[]>();
		if (noteIds.length === 0) return out;
		if (!await this.ensureReady()) return out;
		try {
			const ids = noteIds.map(id => `"${id.replace(/"/g, '')}"`).join(', ');
			const data = await this.rpc<{ noteId?: string; vector?: number[] }[]>('/entities/query', {
				collectionName: this.collections[modality],
				filter: `noteId in [${ids}]`,
				outputFields: ['noteId', 'vector'],
				limit: noteIds.length,
			});
			for (const row of data ?? []) {
				if (typeof row.noteId === 'string' && Array.isArray(row.vector)) out.set(row.noteId, row.vector);
			}
		} catch (err) {
			this.logger.warn(`getNoteVectors failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return out;
	}

	/**
	 * Hard-deletes every note vector authored by the given users from both modality collections. Used by
	 * the admin "purge blocked users" action to remove vectors that were created BEFORE a user was added
	 * to the recommendation blocklist (the embed path skips them going forward). Best-effort per collection.
	 */
	@bindThis
	public async deleteNoteVectorsByUsers(userIds: string[]): Promise<void> {
		if (userIds.length === 0) return;
		if (!await this.ensureReady()) return;
		const list = userIds.map(id => `"${id.replace(/"/g, '')}"`).join(', ');
		for (const name of Object.values(this.collections)) {
			try {
				await this.rpc('/entities/delete', { collectionName: name, filter: `userId in [${list}]` });
			} catch (err) {
				this.logger.warn(`deleteNoteVectorsByUsers failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Of the given note ids, which currently have a vector in EITHER collection. Lightweight membership
	 * check (returns ids only, not vectors) — used to restrict backfills to notes actually in the store.
	 */
	@bindThis
	public async getExistingNoteIds(noteIds: string[]): Promise<Set<string>> {
		const out = new Set<string>();
		if (noteIds.length === 0) return out;
		if (!await this.ensureReady()) return out;
		const ids = noteIds.map(id => `"${id.replace(/"/g, '')}"`).join(', ');
		for (const name of Object.values(this.collections)) {
			try {
				const data = await this.rpc<{ noteId?: string }[]>('/entities/query', {
					collectionName: name,
					filter: `noteId in [${ids}]`,
					outputFields: ['noteId'],
					limit: noteIds.length,
				});
				for (const row of data ?? []) if (typeof row.noteId === 'string') out.add(row.noteId);
			} catch (err) {
				this.logger.warn(`getExistingNoteIds failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return out;
	}

	/**
	 * TTL eviction: drop note vectors older than the given timestamp (ms) from both collections.
	 */
	@bindThis
	public async deleteOldNoteVectors(beforeTs: number): Promise<void> {
		if (!await this.ensureReady()) return;
		for (const name of Object.values(this.collections)) {
			try {
				await this.rpc('/entities/delete', { collectionName: name, filter: `createdAt < ${beforeTs}` });
			} catch (err) {
				this.logger.warn(`deleteOldNoteVectors failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Removes specific notes from both note-vector collections (e.g. notes the quality scorer rejected
	 * as lowest-tier), so they can never be returned as ANN candidates. Best-effort; a note absent from a
	 * collection is a no-op there.
	 */
	@bindThis
	public async deleteNoteVectors(noteIds: string[]): Promise<void> {
		if (noteIds.length === 0) return;
		if (!await this.ensureReady()) return;
		const ids = noteIds.map(id => `"${id.replace(/"/g, '')}"`).join(', ');
		for (const name of Object.values(this.collections)) {
			try {
				await this.rpc('/entities/delete', { collectionName: name, filter: `noteId in [${ids}]` });
			} catch (err) {
				this.logger.warn(`deleteNoteVectors failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}
