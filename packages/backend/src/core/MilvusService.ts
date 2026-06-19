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

/**
 * Vector store for content-based recommendation retrieval, backed by Milvus's HTTP/REST v2 API.
 * Multimodal (image+text) and text-only embeddings occupy different regions of the space, so they
 * live in SEPARATE collections and are only ever matched within their own modality:
 *  - `${prefix}note_vectors_mm`  — notes embedded with their images (multimodal)
 *  - `${prefix}note_vectors_txt` — text-only notes
 * User interest vectors are kept in Redis (one per modality), not here.
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
					indexParams: [{ fieldName: 'vector', indexName: 'vector_idx', metricType: 'COSINE', indexType: 'AUTOINDEX' }],
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
	 * (already normalized, e.g. ['zh']); empty means no restriction. Ordered by descending similarity.
	 */
	@bindThis
	public async searchByVector(vector: number[], topK: number, langs: string[], modality: Modality): Promise<AnnHit[]> {
		if (!await this.ensureReady()) return [];
		const filter = langs.length > 0
			? `lang in [${langs.map(l => `"${l.replace(/"/g, '')}"`).join(', ')}]`
			: undefined;
		try {
			const data = await this.rpc<{ noteId?: string; distance?: number }[]>('/entities/search', {
				collectionName: this.collections[modality],
				data: [vector],
				annsField: 'vector',
				limit: topK,
				outputFields: ['noteId'],
				...(filter ? { filter } : {}),
			});
			return (data ?? [])
				.filter((r): r is { noteId: string; distance?: number } => typeof r.noteId === 'string')
				.map(r => ({ noteId: r.noteId, score: typeof r.distance === 'number' ? r.distance : 0 }));
		} catch (err) {
			this.logger.warn(`searchByVector failed: ${err instanceof Error ? err.message : String(err)}`);
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
}
