/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Ops tool: enqueues 'score' jobs for notes that have a Milvus vector but no topic yet, so the score
 * worker classifies their topic (reusing cached quality — it does NOT re-run quality scoring). Mirrors
 * RecommendationService.backfillTopics, but THROTTLED: it holds the score-queue backlog around a target
 * so effective LLM concurrency stays gentle on the shared vLLM (worker concurrency = min(48, pending)).
 * Resumable — already-topiced notes are skipped, so re-running continues. Run AFTER deploying the topic
 * code (so the worker actually classifies). Reuses the app's own queue options for correct queue keys.
 *
 *   node packages/backend/scripts/enqueue-topic-backfill.mjs [maxPending] [limit] [days]
 *     maxPending  target score-queue backlog (≈ effective LLM concurrency), default 24
 *     limit       max jobs to enqueue this run, 0 = all (default 0)
 *     days        how far back to scan (default 65; Milvus retention is 60d)
 */
import pg from 'pg';
import * as Bull from 'bullmq';
import { loadConfig } from '../built/config.js';
import { QUEUE, baseQueueOptions } from '../built/queue/const.js';
import { pg as PG } from './_config.mjs';
const SUPPORTED = ['zh', 'en', 'ja'];
const AID_EPOCH = 946684800000;
const MAX_PENDING = parseInt(process.argv[2] ?? '24', 10);
const LIMIT = parseInt(process.argv[3] ?? '0', 10);
const DAYS = parseInt(process.argv[4] ?? '65', 10);

const config = loadConfig();
const rec = config.recommendation ?? {};
const MILVUS_URL = (rec.milvusUrl ?? '').replace(/\/$/, '');
const MILVUS_TOKEN = rec.milvusToken;
const PREFIX = rec.milvusCollectionPrefix ?? 'sharkey_rec_';
const COLLECTIONS = [`${PREFIX}note_vectors_txt`, `${PREFIX}note_vectors_mm`];

const db = new pg.Client(PG);
await db.connect();
const queue = new Bull.Queue(QUEUE.SCORE, baseQueueOptions(config, QUEUE.SCORE));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function milvusPresent(ids) {
	const present = new Set();
	if (!MILVUS_URL) return new Set(ids); // milvus off → don't filter
	const filter = `noteId in [${ids.map(id => `"${id}"`).join(', ')}]`;
	for (const col of COLLECTIONS) {
		try {
			const res = await fetch(`${MILVUS_URL}/v2/vectordb/entities/query`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...(MILVUS_TOKEN ? { Authorization: `Bearer ${MILVUS_TOKEN}` } : {}) },
				body: JSON.stringify({ collectionName: col, filter, outputFields: ['noteId'], limit: ids.length }),
				signal: AbortSignal.timeout(20000),
			});
			const json = await res.json();
			for (const row of json.data ?? []) if (row.noteId) present.add(row.noteId);
		} catch (e) { console.error(`milvus query ${col}: ${e.message}`); }
	}
	return present;
}

// Lazily yields Milvus-resident, topic-less note ids (newest-first).
async function* candidates() {
	const sinceId = Math.max(0, Date.now() - DAYS * 86400000 - AID_EPOCH).toString(36).padStart(8, '0');
	let lastId = null;
	for (;;) {
		const params = [SUPPORTED, sinceId];
		let sql = `SELECT n.id FROM note n
			WHERE n.visibility='public' AND n."channelId" IS NULL AND n.text IS NOT NULL
			  AND n.lang = ANY($1) AND n.id > $2
			  AND NOT EXISTS (SELECT 1 FROM note_topic t WHERE t."noteId" = n.id)`;
		if (lastId) { sql += ` AND n.id < $3`; params.push(lastId); }
		sql += ` ORDER BY n.id DESC LIMIT 1000`;
		const { rows } = await db.query(sql, params);
		if (rows.length === 0) return;
		lastId = rows[rows.length - 1].id;
		const present = await milvusPresent(rows.map(r => r.id));
		for (const r of rows) if (present.has(r.id)) yield r.id;
	}
}

const addOpts = { removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 30000 } };
let enqueued = 0, scannedNonMilvus = 0;
const t0 = Date.now();
const it = candidates();
let done = false;
while (!done) {
	const backlog = (await queue.getWaitingCount()) + (await queue.getActiveCount());
	const room = MAX_PENDING - backlog;
	if (room <= 0) { await sleep(800); continue; }
	for (let i = 0; i < room; i++) {
		const { value: id, done: d } = await it.next();
		if (d) { done = true; break; }
		await queue.add('score', { noteId: id }, { ...addOpts, jobId: `score:${id}` });
		if (++enqueued >= LIMIT && LIMIT > 0) { done = true; break; }
	}
	const rate = enqueued / ((Date.now() - t0) / 1000);
	const topiced = (await db.query('SELECT count(*)::int AS c FROM note_topic')).rows[0].c;
	console.log(`enqueued ${enqueued} | backlog ${backlog} | note_topic rows ${topiced} | ${rate.toFixed(1)}/s`);
}

console.log(`\ndone: enqueued ${enqueued} job(s). Worker drains the rest; re-run to continue.`);
await queue.close();
await db.end();
