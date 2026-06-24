/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-off: evict the lowest-quality tier (LLM q < RETRIEVAL_QUALITY_MIN, i.e. q=1) from the Milvus
 * note-vector collections, so they can never be retrieved as ANN discovery candidates. Forward
 * population is handled in RecommendationService.recordNoteFeatures (score job evicts q=1) +
 * EmbedNoteProcessorService (skips re-adding); this clears the pre-existing backlog.
 *
 * Scans the rec:feat Redis cache (source of truth for q), collects q=1 note ids, and batch-deletes
 * them from both collections (a delete of an id not present is a harmless no-op).
 *
 *   node packages/backend/scripts/evict-lowq-milvus.mjs --dry-run   # count only, no delete
 *   node packages/backend/scripts/evict-lowq-milvus.mjs             # evict
 */
import Redis from 'ioredis';
import { redisConnection as REDIS, milvus } from './_config.mjs';

const DRY = process.argv.includes('--dry-run');
// NB: no keyPrefix — SCAN returns FULL keys (`sharkey:rec:feat:…`), so we mget those full keys directly
// (a keyPrefix would re-prepend `sharkey:` to them and every lookup would miss).
const MILVUS = milvus.url;
const MTOKEN = milvus.token;
const COLL = ['sharkey_rec_note_vectors_mm', 'sharkey_rec_note_vectors_txt'];
const RETRIEVAL_QUALITY_MIN = 2; // q < this (q===1) is evicted — mirror RecommendationService

const redis = new Redis(REDIS);
async function milvusDelete(coll, ids) {
	const res = await fetch(`${MILVUS}/entities/delete`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MTOKEN}` },
		body: JSON.stringify({ collectionName: coll, filter: `noteId in [${ids.map(id => `"${id}"`).join(', ')}]` }),
	});
	const j = await res.json();
	if (j.code !== 0 && j.code !== 200) throw new Error(`Milvus ${j.code}: ${j.message}`);
}

let cursor = '0', scanned = 0, lowq = 0;
let buf = [];
const qd = {};
const flush = async () => {
	if (buf.length === 0) return;
	if (!DRY) for (const coll of COLL) await milvusDelete(coll, buf);
	buf = [];
};
do {
	const [c, keys] = await redis.scan(cursor, 'MATCH', 'sharkey:rec:feat:*', 'COUNT', 5000);
	cursor = c;
	if (keys.length) {
		const vals = await redis.mget(keys);
		for (let i = 0; i < keys.length; i++) {
			const v = vals[i]; if (!v) continue;
			let f; try { f = JSON.parse(v); } catch { continue; }
			if (f.q != null) qd[f.q] = (qd[f.q] ?? 0) + 1;
			if (f.q != null && f.q < RETRIEVAL_QUALITY_MIN) {
				lowq++;
				buf.push(keys[i].replace('sharkey:rec:feat:', ''));
				if (buf.length >= 256) await flush();
			}
		}
		scanned += keys.length;
		if (scanned % 100000 < 5000) console.log(`scanned ${scanned}, q=1 found ${lowq}…`);
	}
} while (cursor !== '0');
await flush();

console.log(`\nq distribution over ${scanned} scored notes:`, qd);
console.log(`${DRY ? '[DRY RUN] would evict' : 'evicted'} ${lowq} q=1 notes from Milvus (both collections).`);
await redis.quit();
