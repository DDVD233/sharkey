/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Ops tool: (1) prioritizes topic classification of the notes users have actually engaged with (those
 * feed the interest arrays), then (2) builds each user's {+1,0,-1} topic-interest array directly into
 * rec:topicint:{userId} — mirroring RecommendationService.computeTopicInterest — WITHOUT waiting for the
 * heavy daily vector recompute (the array only needs rec:engaged + note_topic). Run with the general
 * backfill PAUSED so the engaged-note jobs get the worker.
 *
 *   node packages/backend/scripts/build-user-topic-arrays.mjs [maxPending] [maxWaitSec]
 */
import Redis from 'ioredis';
import pg from 'pg';
import * as Bull from 'bullmq';
import { loadConfig } from '../built/config.js';
import { QUEUE, baseQueueOptions } from '../built/queue/const.js';
import { TOPIC_DOWNRANK_DEFAULT, TOPIC_LABELS } from '../built/core/rec-topics.js';
import { pg as PG, redis as REDIS } from './_config.mjs';
const ENGAGED_MAX = 200;
const TOPIC_TOP_N = 3;
const PUSHED_TTL_SEC = 60 * 60 * 24 * 30;
const MAX_PENDING = parseInt(process.argv[2] ?? '32', 10);
const MAX_WAIT_SEC = parseInt(process.argv[3] ?? '1800', 10);
const REACTION_NORMAL_WEIGHT = 1;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r = new Redis(REDIS);
const db = new pg.Client(PG); await db.connect();
const config = loadConfig();
const queue = new Bull.Queue(QUEUE.SCORE, baseQueueOptions(config, QUEUE.SCORE));

// --- 1. gather every user's engaged notes (weight + id), and the global id set ---
const users = await r.smembers('rec:users');
console.log(`${users.length} users with engagement`);
const perUser = new Map(); // userId -> [{weight, noteId}]
const allIds = new Set();
for (const u of users) {
	const entries = await r.lrange(`rec:engaged:${u}`, 0, ENGAGED_MAX - 1);
	const parsed = entries.map(e => { const i = e.indexOf(':'); return { weight: Number(e.slice(0, i)) || REACTION_NORMAL_WEIGHT, noteId: e.slice(i + 1) }; });
	perUser.set(u, parsed);
	for (const p of parsed) allIds.add(p.noteId);
}
console.log(`${allIds.size} distinct engaged notes`);

// which already have a topic?
async function topicsFor(ids) {
	const map = new Map();
	for (let i = 0; i < ids.length; i += 5000) {
		const chunk = ids.slice(i, i + 5000);
		const { rows } = await db.query('SELECT "noteId", topic FROM note_topic WHERE "noteId" = ANY($1)', [chunk]);
		for (const row of rows) map.set(row.noteId, row.topic);
	}
	return map;
}
const idList = [...allIds];
let topicOf = await topicsFor(idList);
const missing = idList.filter(id => !topicOf.has(id));
console.log(`${topicOf.size} already classified, ${missing.length} to classify (prioritized)`);

// --- 2. enqueue the missing ones (high priority), throttled; the score worker classifies them ---
const addOpts = { removeOnComplete: true, removeOnFail: 100, attempts: 2, backoff: { type: 'exponential', delay: 30000 }, priority: 1 };
let fed = 0;
for (const id of missing) {
	for (;;) {
		const backlog = (await queue.getWaitingCount()) + (await queue.getActiveCount());
		if (backlog < MAX_PENDING) break;
		await sleep(500);
	}
	await queue.add('score', { noteId: id }, { ...addOpts, jobId: `score:${id}` });
	if (++fed % 500 === 0) console.log(`enqueued ${fed}/${missing.length}…`);
}
console.log(`enqueued all ${fed} missing engaged notes; waiting for classification…`);

// --- 3. wait until coverage stops improving (or timeout) ---
const t0 = Date.now();
let prevMissing = missing.length;
for (;;) {
	if (missing.length === 0) break;
	await sleep(5000);
	topicOf = await topicsFor(idList);
	const stillMissing = idList.filter(id => !topicOf.has(id)).length;
	console.log(`coverage: ${idList.length - stillMissing}/${idList.length} classified (${stillMissing} missing)`);
	if (stillMissing === 0) break;
	if ((Date.now() - t0) / 1000 > MAX_WAIT_SEC) { console.log(`max wait reached; building arrays with ${stillMissing} still unclassified (some engaged notes aren't embeddable — that's fine)`); break; }
	prevMissing = stillMissing;
}

// --- 4. build + write each user's {+1,0,-1} interest array (mirrors computeTopicInterest) ---
let written = 0, withTop = 0;
const distSizes = {};
for (const [u, parsed] of perUser) {
	if (parsed.length === 0) { await r.del(`rec:topicint:${u}`); continue; }
	const out = {};
	for (const t of TOPIC_DOWNRANK_DEFAULT) out[t] = -1;
	const wByTopic = new Map();
	for (const p of parsed) { const t = topicOf.get(p.noteId); if (t == null) continue; wByTopic.set(t, (wByTopic.get(t) ?? 0) + p.weight); }
	const topN = [...wByTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPIC_TOP_N);
	for (const [t] of topN) out[t] = 1;
	if (Object.keys(out).length > 0) { await r.set(`rec:topicint:${u}`, JSON.stringify(out), 'EX', PUSHED_TTL_SEC); written++; }
	if (topN.length > 0) withTop++;
	const k = topN.map(x => x[0]).join(',') || '(none)';
	distSizes[topN.length] = (distSizes[topN.length] ?? 0) + 1;
}
console.log(`\ndone: wrote rec:topicint for ${written} users (${withTop} with ≥1 top topic).`);
console.log(`top-topic counts per user:`, distSizes);

// quick aggregate: how often each topic is a +1 across users
const plus = {};
for (const [, parsed] of perUser) {
	const wByTopic = new Map();
	for (const p of parsed) { const t = topicOf.get(p.noteId); if (t == null) continue; wByTopic.set(t, (wByTopic.get(t) ?? 0) + p.weight); }
	for (const [t] of [...wByTopic.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOPIC_TOP_N)) plus[t] = (plus[t] ?? 0) + 1;
}
console.log('most common +1 topics:', Object.entries(plus).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, c]) => `${t}:${c}`).join('  '));
void TOPIC_LABELS;

await queue.close(); await r.quit(); await db.end();
