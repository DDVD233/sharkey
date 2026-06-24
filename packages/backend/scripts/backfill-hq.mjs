/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-off: populate the high-quality discovery index (rec:hq:{lang}) from already-scored notes.
 * Mirrors RecommendationService.indexHighQuality for the backlog. Forward population happens in
 * recordNoteFeatures. Run once after deploy:  node packages/backend/scripts/backfill-hq.mjs [days]
 */
import Redis from 'ioredis';
import pg from 'pg';
import { pg as PG, redisConnection as REDIS } from './_config.mjs';
const HQ_QUALITY_MIN = 4;
const SUPPORTED = ['zh', 'en', 'ja'];
const AID_EPOCH = 946684800000;
const DAYS = parseInt(process.argv[2] ?? '14', 10);

const normLang = l => { if (l == null) return null; const b = String(l).toLowerCase().trim().split(/[-_]/)[0]; return b === '' ? null : (b === 'zh' ? 'zh' : b); };
const tsOf = id => parseInt(id.slice(0, 8), 36) + AID_EPOCH;

const r = new Redis(REDIS);
const db = new pg.Client(PG); await db.connect();

const sinceMs = Date.now() - DAYS * 86400000;
let lastId = null, scanned = 0, indexed = 0;
const perLang = {};
for (;;) {
	const params = [SUPPORTED, Math.max(0, sinceMs - AID_EPOCH).toString(36).padStart(8, '0')];
	let sql = `SELECT n.id, n.lang FROM note n WHERE n.visibility='public' AND n."channelId" IS NULL
		AND n.text IS NOT NULL AND n.lang = ANY($1) AND n.id > $2`;
	if (lastId) { sql += ` AND n.id < $3`; params.push(lastId); }
	sql += ` ORDER BY n.id DESC LIMIT 1000`;
	const { rows } = await db.query(sql, params);
	if (rows.length === 0) break;
	const feats = await r.mget(rows.map(x => `sharkey:rec:feat:${x.id}`));
	const pipe = r.pipeline();
	for (let i = 0; i < rows.length; i++) {
		if (!feats[i]) continue;
		let f; try { f = JSON.parse(feats[i]); } catch { continue; }
		if (f.q == null || f.q < HQ_QUALITY_MIN) continue;
		const lang = normLang(rows[i].lang);
		if (!lang) continue;
		pipe.zadd(`sharkey:rec:hq:${lang}`, tsOf(rows[i].id), rows[i].id);
		indexed++; perLang[lang] = (perLang[lang] ?? 0) + 1;
	}
	await pipe.exec();
	scanned += rows.length;
	lastId = rows[rows.length - 1].id;
	if (scanned % 20000 === 0) console.log(`scanned ${scanned}, indexed ${indexed}…`);
}
// set TTL on each lang key
for (const lang of Object.keys(perLang)) await r.expire(`sharkey:rec:hq:${lang}`, DAYS * 86400 + 86400);
console.log(`done: scanned ${scanned}, indexed ${indexed}`, perLang);
await r.quit(); await db.end();
