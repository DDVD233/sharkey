/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Boots the real backend DI context and runs the ACTUAL recommendation path for a brand-new
 * synthetic user (no interactions, no follows), then prints the 1st batch as it would be served.
 * Non-mutating: uses a throwaway userId and deletes its queue keys at the end.
 *   node packages/backend/scripts/sim-newuser.mjs [lang] [limit]
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import pg from 'pg';
import { GlobalModule } from '../built/GlobalModule.js';
import { CoreModule } from '../built/core/CoreModule.js';
import { RecommendationService } from '../built/core/RecommendationService.js';
import { pg as PG, redisConnection as REDIS } from './_config.mjs';

// Ad-hoc root module: GlobalModule (config/db/redis infra) + CoreModule (services).
class SimModule {}
Module({ imports: [GlobalModule, CoreModule] })(SimModule);

const LANG = process.argv[2] ?? 'zh';
const LIMIT = parseInt(process.argv[3] ?? '15', 10);
const fakeId = 'simnewuser000000'; // not a real user → behaves exactly like a brand-new account
const AID_EPOCH = 946684800000;
const ageStr = id => { const a = (Date.now() - (parseInt(id.slice(0, 8), 36) + AID_EPOCH)) / 3.6e6; return a < 24 ? `${a.toFixed(0)}h` : `${(a / 24).toFixed(1)}d`; };
const snip = t => (t ? t.replace(/\s+/g, ' ').trim().slice(0, 46) : '∅(no text)');

const redis = new Redis(REDIS);
const db = new pg.Client(PG);
await db.connect();

process.on('unhandledRejection', e => { console.error('UNHANDLED:', e); process.exit(2); });
console.log('booting DI context…');
let app;
try {
	app = await NestFactory.createApplicationContext(SimModule, { logger: ['error', 'warn'] });
} catch (e) {
	console.error('BOOT FAILED:', e?.message ?? e);
	console.error(e?.stack?.split('\n').slice(0, 6).join('\n'));
	process.exit(3);
}
const rec = app.get(RecommendationService);

// Confirm the user truly looks brand-new before we build.
const langs = await rec.resolveLangs(fakeId, LANG);
console.log(`resolved langs: [${langs}]  (fakeId=${fakeId})`);

// Run the REAL candidate-queue build (cold path: no interest vector → ANN skipped → q≥4 pool only).
const n = await rec.buildCandidateQueue(fakeId, langs, true);
console.log(`buildCandidateQueue → ${n} candidates ranked & queued\n`);

// The queue head IS the served 1st batch (getPage pops `limit` from the front).
const key = `rec:queue:${fakeId}:${langs[0] ?? 'all'}`;
const raw = await redis.lrange(`sharkey:${key}`, 0, LIMIT - 1);
const entries = raw.map(e => JSON.parse(e)); // { s: source, n: noteId, f: feat }
const ids = entries.map(e => e.n);

const { rows } = ids.length ? await db.query('SELECT id, text, lang FROM note WHERE id = ANY($1)', [ids]) : { rows: [] };
const byId = new Map(rows.map(r => [r.id, r]));

console.log(`=== NEW USER 1st BATCH  lang=${LANG}  (real serving path) ===`);
console.log('  # src      age     lang  ann  Q    rec  len? img score   text');
entries.forEach((e, i) => {
	const f = e.f ?? {};
	const note = byId.get(e.n) ?? {};
	console.log(
		`${String(i + 1).padStart(3)} ${String(e.s).padEnd(8)} ${ageStr(e.n).padStart(6)}  ${String(note.lang ?? '∅').padEnd(4)} ` +
		`${(f.ann ?? 0).toFixed(2)} ${(f.quality ?? 0).toFixed(2)} ${(f.recency ?? 0).toFixed(2)}  ${f.mm ? 'Y' : '·'}   ${f.mm ? 'Y' : '·'}  ${(f.score ?? 0).toFixed(3)}  ${snip(note.text)}`);
});

// distribution
const imgN = entries.filter(e => e.f?.mm).length;
const q = entries.map(e => e.f?.quality ?? 0);
console.log(`\nimages: ${(100 * imgN / entries.length).toFixed(0)}%   avg quality: ${(q.reduce((a, b) => a + b, 0) / (q.length || 1)).toFixed(2)}   sources: ${[...new Set(entries.map(e => e.s))].join(',')}`);

// full-queue modality split + where the first text post lands (backload check)
const full = (await redis.lrange(`sharkey:${key}`, 0, -1)).map(e => JSON.parse(e));
const fullImg = full.filter(e => e.f?.mm).length;
const firstTextPos = full.findIndex(e => e.f && !e.f.mm);
console.log(`full queue: ${full.length} total, ${fullImg} image (${(100 * fullImg / full.length).toFixed(0)}%), ${full.length - fullImg} text; first TEXT post at position ${firstTextPos + 1}`);

// cleanup throwaway state
await redis.del(`sharkey:${key}`, `sharkey:rec:pushed:${fakeId}`, `sharkey:rec:dirty:${fakeId}`,
	`sharkey:rec:uvec:mm:${fakeId}`, `sharkey:rec:uvec:txt:${fakeId}`, `sharkey:rec:engaged:${fakeId}`,
	`sharkey:rec:langaff:${fakeId}`, `sharkey:rec:modality:${fakeId}`);
await redis.srem('sharkey:rec:users', fakeId);
await db.query('DELETE FROM note_recommendation_impressions WHERE "userId" = $1', [fakeId]).catch(() => {});
console.log('cleaned up throwaway user state.');

await app.close();
await redis.quit();
await db.end();
process.exit(0);
