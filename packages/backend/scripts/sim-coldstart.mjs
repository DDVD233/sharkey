/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Cold-start simulation: replays RecommendationService's path for a brand-new user (0 engagement,
 * 0 follows) and prints the posts they'd be served, with a per-factor score breakdown. Read-only:
 * connects to the live Postgres + Redis, writes nothing.
 *
 *   node packages/backend/scripts/sim-coldstart.mjs [lang] [limit]
 *   e.g. node packages/backend/scripts/sim-coldstart.mjs zh 20
 */
import Redis from 'ioredis';
import pg from 'pg';
import { analyzeNoteText, lengthReward, LEN_FLOOR } from '../built/misc/note-quality.js';
import { pg as PG, redis as REDIS } from './_config.mjs';

// --- constants mirrored from RecommendationService.ts (cold user: alpha=0) ---
const FEATURED_THRESHOLD = 100;
const RECENCY_PLATEAU_HOURS = 48, RECENCY_DECAY_HALF_LIFE_HOURS = 24 * 12, RECENCY_FLOOR = 0.6;
const LENGTH_FLOOR = 0.6;
const TAG_SOFT_MAX = 3, TAG_OVERTAG_PENALTY = 0.2;
const REPLY_PENALTY = 0.65;
const QP_QUALITY = 0.9, QP_ENGAGEMENT = 0.1;
const BASE_SELECTED_LANG = 0.7, NULL_LANG_WEIGHT = 0.2;
const IMAGE_POLICY_BONUS = 0.02;
const GLOBAL_WINDOW_MS = 1000 * 60 * 60 * 24 * 3;
const FEATURED_EPOC = new Date('2023-01-01T00:00:00Z').getTime();
const AID_EPOCH = 946684800000; // 2000-01-01, for `id: aid`

const llmTo01 = q => Math.max(0, Math.min(1, q / 5));
const normalizeLang = l => { if (l == null) return null; const b = String(l).toLowerCase().trim().split(/[-_]/)[0]; return b === '' ? null : (b === 'zh' ? 'zh' : b); };
const ageHoursOf = id => (Date.now() - (parseInt(id.slice(0, 8), 36) + AID_EPOCH)) / 3.6e6;

const selectedLang = process.argv[2] ?? 'zh';
const LIMIT = parseInt(process.argv[3] ?? '20', 10);

const redis = new Redis(REDIS);
const db = new pg.Client(PG);
await db.connect();

// --- 1. cold-start candidate pool = recent high-quality (q>=4) index for the selected language ---
const HQ_WINDOW_MS = 1000 * 60 * 60 * 24 * 14;
const globalIds = await redis.zrevrangebyscore(`rec:hq:${selectedLang}`, Date.now(), Date.now() - HQ_WINDOW_MS, 'LIMIT', 0, 800);

// --- helpers to load notes from PG ---
const loadNotes = async ids => {
	if (ids.length === 0) return [];
	const { rows } = await db.query(`
		SELECT n.id, n."userId", n.text, n.lang, n."replyId", n."renoteCount", n."repliesCount",
		       n.reactions, n.visibility, r."userId" AS reply_user,
		       EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(n."fileIds") AND df.type LIKE 'image/%') AS has_image
		FROM note n JOIN "user" u ON u.id = n."userId" LEFT JOIN note r ON r.id = n."replyId"
		WHERE n.id = ANY($1) AND n."channelId" IS NULL AND u."isExplorable" = TRUE AND n.visibility = 'public'`, [ids]);
	return rows;
};

const featOf = async ids => {
	if (ids.length === 0) return new Map();
	const raws = await redis.mget(ids.map(id => `rec:feat:${id}`));
	const m = new Map();
	ids.forEach((id, i) => { if (raws[i]) try { m.set(id, JSON.parse(raws[i])); } catch {} });
	return m;
};

const qualityOf = f => f == null ? 0 : (f.q != null ? llmTo01(f.q) : f.sq);
const engagementOf = n => { let r = 0; for (const v of Object.values(n.reactions ?? {})) r += v; return r + n.renoteCount + n.repliesCount; };

// --- 2. score a note exactly as rankCandidates does for a cold user (alpha=0, no follows) ---
const langWeights = new Map([[selectedLang, Math.max(BASE_SELECTED_LANG, 0)]]); // cold: only selected lang
const nullLangWeight = NULL_LANG_WEIGHT; // langAffinityTotal 0 < STRICT_LANG_MIN_AFFINITY
const scoreNote = (n, feat) => {
	const norm = normalizeLang(n.lang);
	const langW = norm != null ? (langWeights.get(norm) ?? 0) : nullLangWeight;
	if (langW <= 0) return null; // dropped (other language)
	const isMm = n.has_image;
	const quality = qualityOf(feat);
	const engagement = Math.min(1, Math.log1p(engagementOf(n)) / Math.log1p(1000));
	const age = ageHoursOf(n.id);
	const recencyDecay = age <= RECENCY_PLATEAU_HOURS ? 1 : Math.pow(0.5, (age - RECENCY_PLATEAU_HOURS) / RECENCY_DECAY_HALF_LIFE_HOURS);
	const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * recencyDecay;
	const a = analyzeNoteText(n.text);
	const lenNorm = Math.max(0, (lengthReward(a.readableLength) - LEN_FLOOR) / (1 - LEN_FLOOR));
	const lengthGate = isMm ? 1 : LENGTH_FLOOR + (1 - LENGTH_FLOOR) * lenNorm;
	const tagPenalty = a.hashtagCount <= TAG_SOFT_MAX ? 1 : Math.max(0.05, TAG_OVERTAG_PENALTY * Math.pow(0.7, a.hashtagCount - TAG_SOFT_MAX - 1));
	const isSelfReply = n.replyId != null && n.reply_user != null && n.reply_user === n.userId;
	const replyPenalty = (n.replyId != null && !isSelfReply) ? REPLY_PENALTY : 1;
	const base = QP_QUALITY * quality + QP_ENGAGEMENT * engagement; // alphaBlend=0 → no relevance term
	let score = base * recency * lengthGate * langW + (isMm ? IMAGE_POLICY_BONUS : 0);
	score *= tagPenalty * replyPenalty;
	return { score, age, quality, recency, lengthGate, tags: a.hashtagCount, len: a.readableLength, isMm, isReply: replyPenalty < 1, langW };
};

// --- 3. recent-language tail (the fallback that fills the page) ---
const getRecentTail = async (excludeIds, n) => {
	const { rows } = await db.query(`
		SELECT n.id FROM note n JOIN "user" u ON u.id = n."userId"
		WHERE n.visibility = 'public' AND n."channelId" IS NULL AND u."isExplorable" = TRUE
		  AND (n.lang = ANY($1) OR n.lang IS NULL)
		ORDER BY n.id DESC LIMIT $2`, [[selectedLang], Math.min(1000, (n + excludeIds.length) * 3)]);
	const ex = new Set(excludeIds);
	return rows.map(r => r.id).filter(id => !ex.has(id)).slice(0, n);
};

// --- assemble the cold-start page like getPage(refresh, offset=0) ---
const gnotes = await loadNotes(globalIds);
const gfeat = await featOf(gnotes.map(n => n.id));
const scoredGlobal = gnotes.map(n => ({ n, ...(scoreNote(n, gfeat.get(n.id)) ?? {}), dropped: scoreNote(n, gfeat.get(n.id)) == null }))
	.filter(x => !x.dropped).sort((a, b) => b.score - a.score);

const fromTrending = scoredGlobal.slice(0, LIMIT);
const tailIds = await getRecentTail(fromTrending.map(x => x.n.id), LIMIT - fromTrending.length);
const tnotes = await loadNotes(tailIds);
const tfeat = await featOf(tailIds);
const byId = new Map(tnotes.map(n => [n.id, n]));
const fromTail = tailIds.map(id => byId.get(id)).filter(Boolean).map(n => ({ n, src: 'tail', ...(scoreNote(n, tfeat.get(n.id)) ?? {}) }));

const page = [...fromTrending.map(x => ({ ...x, src: 'trending' })), ...fromTail];

// --- print ---
const snip = t => (t ? t.replace(/\s+/g, ' ').trim().slice(0, 48) : '∅(no text)');
console.log(`\n=== COLD-START FEED  lang=${selectedLang}  limit=${LIMIT} ===`);
console.log(`global trending pool: ${globalIds.length} ids → ${gnotes.length} loaded → ${scoredGlobal.length} survive lang filter`);
console.log(`page = ${fromTrending.length} trending + ${fromTail.length} recent-tail fill\n`);
console.log('  # src       age      lang  Q    rec  len  tags img rep  score   text');
page.forEach((x, i) => {
	const ageStr = x.age == null ? '   ?' : x.age < 24 ? `${x.age.toFixed(0)}h` : `${(x.age / 24).toFixed(1)}d`;
	console.log(
		`${String(i + 1).padStart(3)} ${x.src.padEnd(9)} ${ageStr.padStart(6)}  ${String(x.n.lang ?? '∅').padEnd(4)} ` +
		`${(x.quality ?? 0).toFixed(2)} ${(x.recency ?? 0).toFixed(2)} ${(x.lengthGate ?? 0).toFixed(2)} ${String(x.tags ?? 0).padStart(3)}  ` +
		`${x.isMm ? 'Y' : '·'}  ${x.isReply ? 'Y' : '·'}  ${(x.score ?? 0).toFixed(3)}  ${snip(x.n.text)}`);
});

// --- aggregate analysis ---
const ages = page.map(x => x.age).filter(a => a != null).sort((a, b) => a - b);
const med = ages.length ? ages[Math.floor(ages.length / 2)] : 0;
const pct = p => (100 * p / page.length).toFixed(0) + '%';
console.log(`\n=== DISTRIBUTION (n=${page.length}) ===`);
console.log(`median age: ${(med / 24).toFixed(1)}d   |  >7d: ${pct(ages.filter(a => a > 168).length)}   >30d: ${pct(ages.filter(a => a > 720).length)}`);
console.log(`images: ${pct(page.filter(x => x.isMm).length)}   replies: ${pct(page.filter(x => x.isReply).length)}   over-tagged(>3): ${pct(page.filter(x => (x.tags ?? 0) > 3).length)}`);
console.log(`with LLM/struct quality>0: ${pct(page.filter(x => (x.quality ?? 0) > 0).length)}   avg quality: ${(page.reduce((s, x) => s + (x.quality ?? 0), 0) / page.length).toFixed(2)}`);
const langDist = {}; for (const x of page) { const k = x.n.lang ?? '∅'; langDist[k] = (langDist[k] ?? 0) + 1; }
console.log(`langs: ${Object.entries(langDist).map(([k, v]) => `${k}:${v}`).join('  ')}`);

await redis.quit();
await db.end();
