/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Shared connection config for the local recommendation ops/analysis scripts.
 *
 * Reads the SAME YAML the server uses (.config/default.yml, or test.yml under
 * NODE_ENV=test, or whatever MISSKEY_CONFIG_YML / MISSKEY_CONFIG_DIR point at),
 * so no script has to hardcode DB / Redis / Milvus credentials. This is a tiny
 * standalone reader (no `built/` import) so the lightweight scripts still run
 * without a prior build; it mirrors the path resolution in src/config.ts.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as yaml from 'js-yaml';

const _dirname = dirname(fileURLToPath(import.meta.url));
const dir = process.env.MISSKEY_CONFIG_DIR ?? resolve(_dirname, '../../../.config');
const ymlName = process.env.MISSKEY_CONFIG_YML ?? (process.env.NODE_ENV === 'test' ? 'test.yml' : 'default.yml');

/** The raw parsed config object. */
export const config = yaml.load(fs.readFileSync(resolve(dir, ymlName), 'utf-8'));

// The recommendation engine reads its Redis state from redisForTimelines, which
// falls back to the main `redis` block when not separately configured.
const _redis = config.redisForTimelines ?? config.redis ?? {};
const _db = config.db ?? {};
const _rec = config.recommendation ?? {};

/** node-postgres client options (`new pg.Client(pg)`). */
export const pg = {
	host: _db.host,
	port: _db.port,
	user: _db.user,
	password: _db.pass,
	database: _db.db,
};

/** ioredis options WITHOUT a keyPrefix — for full-key access (SCAN results, BullMQ, etc.). */
export const redisConnection = {
	host: _redis.host,
	port: _redis.port,
	...(_redis.db != null ? { db: _redis.db } : {}),
	...(_redis.pass ? { password: _redis.pass } : {}),
};

/** ioredis options WITH the server's key prefix (`<prefix>:`) — matches DI.redisForTimelines. */
export const redis = {
	...redisConnection,
	...(_redis.prefix ? { keyPrefix: `${_redis.prefix}:` } : {}),
};

/** BullMQ queue key prefix (`<redis prefix>:queue`). */
export const queuePrefix = `${_redis.prefix ?? 'sharkey'}:queue`;

const _milvusBase = (_rec.milvusUrl ?? '').replace(/\/$/, '');

/** Milvus REST details. `url` is the `/v2/vectordb` root the scripts POST to. */
export const milvus = {
	base: _milvusBase || null,
	url: _milvusBase ? `${_milvusBase}/v2/vectordb` : null,
	token: _rec.milvusToken ?? null,
	collectionPrefix: _rec.milvusCollectionPrefix ?? 'sharkey_rec_',
};

/** The raw `recommendation` config block (embeddingUrl, milvus*, etc.). */
export const recommendation = _rec;
