/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Precompute + PERSIST the missing ranker features into note_recommendation_impression, so the
 * impression log becomes a complete feature store and the learner (learn-coef.mjs) just reads it.
 *
 * Fills, via COALESCE (NEVER overwriting a real serve-time snapshot):
 *  - authorScore : LEAK-FREE replay of the user↔author-centroid cosine (see below). Currently null
 *                  on every row (the writer that records it at serve time isn't deployed yet).
 *  - cfScore     : 0 — the CF source surfaced 0 impressions in this window, so its faithful value is 0.
 *  - annScore / qualityScore / recencyScore / langWeight / followed / isMultimodal : for fallback
 *                  (page-fill) rows that were served without a score breakdown. annScore=0 is faithful
 *                  (they were never ANN-retrieved); the rest are reconstructed from note/rec:feat/graph.
 *
 * authorScore is leak-free: we REPLAY each user's online-EMA interest vector from their timestamped
 * engagement history (Postgres) and at each impression's serve time T use only engagements with ts < T.
 * The author centroid is an EMA over the AUTHOR's own posts (independent of this user's label), so its
 * current value carries no leak. We also re-derive annScore and validate it against the stored
 * serve-time value to prove the replay is faithful (printed before any write).
 *
 * Read-mostly: the ONLY writes are UPDATEs to note_recommendation_impression feature columns.
 *   node packages/backend/scripts/backfill-impression-features.mjs            # validate + write
 *   node packages/backend/scripts/backfill-impression-features.mjs --dry-run  # validate only, no write
 */
import Redis from 'ioredis';
import pg from 'pg';
import { pg as PG, redis as REDIS, milvus } from './_config.mjs';

const DRY = process.argv.includes('--dry-run');
const MILVUS = milvus.url;
const MTOKEN = milvus.token;
const COLL = { mm: 'sharkey_rec_note_vectors_mm', txt: 'sharkey_rec_note_vectors_txt' };

const RECENCY_PLATEAU_HOURS = 48, RECENCY_DECAY_HALF_LIFE_HOURS = 24 * 12, RECENCY_FLOOR = 0.6;
const BASE_SELECTED_LANG = 0.7, EMA_ALPHA = 0.2, AUTHOR_CENTROID_MIN_NOTES = 3;
const REPLY_WEIGHT = 3, RENOTE_WEIGHT = 2, FAVORITE_WEIGHT = 2, REACTION_RARE_WEIGHT = 1.5, REACTION_NORMAL_WEIGHT = 1;
const AID_EPOCH = 946684800000, HISTORY_DAYS = 45;
// Structural-signal constants (mirror misc/note-quality.ts + RecommendationService rank-time penalties).
const LEN_FLOOR = 0.15, PEAK_LEN = 100, PLATEAU_LOG = 0.2, LEN_SIGMA = 0.9, TAG_SOFT_MAX = 3, TAG_PENALTY_RANGE = 5;
const llmTo01 = q => Math.max(0, Math.min(1, q / 5));
const tsOf = id => parseInt(String(id).slice(0, 8), 36) + AID_EPOCH;
const clamp01 = x => Math.max(0, Math.min(1, x));
const lengthReward = len => { if (!(len > 0)) return LEN_FLOOR; const beyond = Math.max(0, Math.abs(Math.log(len) - Math.log(PEAK_LEN)) - PLATEAU_LOG); return Math.max(LEN_FLOOR, Math.exp(-0.5 * (beyond / LEN_SIGMA) ** 2)); };
const cosine = (a, b) => { if (!a || !b || a.length !== b.length) return 0; let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0; };

const redis = new Redis(REDIS);
const db = new pg.Client(PG); await db.connect();

const { rows: imps } = await db.query(`
  SELECT id, "userId", "noteId", EXTRACT(EPOCH FROM "pushedAt")*1000 AS pushed_ms,
         "annScore", "qualityScore", "recencyScore", "langWeight", "followed", "isMultimodal", score
  FROM note_recommendation_impression`);
console.log(`loaded ${imps.length} impressions${DRY ? '  [DRY RUN]' : ''}`);
const impUserIds = [...new Set(imps.map(i => i.userId))];
const impNoteIds = [...new Set(imps.map(i => i.noteId))];

// note meta + follow graph + rec:feat + author centroids
const noteMeta = new Map();
{
	const { rows } = await db.query(`SELECT n.id, n."userId" AS author, n."replyId", n."replyUserId", n.tags,
		n.reactions, n."renoteCount", n."repliesCount",
		EXISTS (SELECT 1 FROM drive_file df WHERE df.id=ANY(n."fileIds") AND df.type LIKE 'image/%') AS has_image
		FROM note n WHERE n.id=ANY($1)`, [impNoteIds]);
	for (const r of rows) {
		let reactSum = 0; for (const v of Object.values(r.reactions ?? {})) reactSum += Number(v) || 0;
		const engagementRaw = reactSum + (r.renoteCount ?? 0) + (r.repliesCount ?? 0);
		noteMeta.set(r.id, {
			authorId: r.author, createdMs: tsOf(r.id), hasImage: r.has_image,
			replyId: r.replyId, replyUserId: r.replyUserId, tagCount: Array.isArray(r.tags) ? r.tags.length : 0,
			popularity: Math.min(1, Math.log1p(engagementRaw) / Math.log1p(1000)),
		});
	}
}
// Note topics + per-user topic-interest arrays → topicInterest signal.
const noteTopic = new Map();
{ const { rows } = await db.query(`SELECT "noteId", topic FROM note_topic WHERE "noteId"=ANY($1)`, [impNoteIds]); for (const r of rows) noteTopic.set(r.noteId, r.topic); }
const topicInterestOf = new Map();
{ const raws = await redis.mget(impUserIds.map(u => `rec:topicint:${u}`)); impUserIds.forEach((u, i) => { try { topicInterestOf.set(u, raws[i] ? JSON.parse(raws[i]) : {}); } catch { topicInterestOf.set(u, {}); } }); }
const followees = new Map();
{
	const { rows } = await db.query(`SELECT "followerId","followeeId" FROM following WHERE "followerId"=ANY($1)`, [impUserIds]);
	for (const r of rows) { if (!followees.has(r.followerId)) followees.set(r.followerId, new Set()); followees.get(r.followerId).add(r.followeeId); }
}
const feats = await redis.mget(impNoteIds.map(id => `rec:feat:${id}`));
const featOf = new Map();
impNoteIds.forEach((id, i) => { if (feats[i]) { try { featOf.set(id, JSON.parse(feats[i])); } catch { /* skip */ } } });
const authorIds = [...new Set([...noteMeta.values()].map(m => m.authorId))];
const centroid = { mm: new Map(), txt: new Map() };
for (const mod of ['mm', 'txt']) {
	const raws = await redis.mget(authorIds.map(a => `rec:avec:${mod}:${a}`));
	authorIds.forEach((a, i) => { if (raws[i]) { try { const o = JSON.parse(raws[i]); if (Array.isArray(o.v) && o.n >= AUTHOR_CENTROID_MIN_NOTES) centroid[mod].set(a, o.v); } catch { /* skip */ } } });
}
console.log(`author centroids: mm=${centroid.mm.size} txt=${centroid.txt.size}`);

// engagement history (last HISTORY_DAYS) for the vector replay
const sinceId = Math.max(0, Date.now() - HISTORY_DAYS * 86400000 - AID_EPOCH).toString(36).padStart(8, '0');
const history = new Map();
const pushHist = (uid, noteId, weight, ts) => { if (!noteId) return; if (!history.has(uid)) history.set(uid, []); history.get(uid).push({ noteId, weight, ts }); };
{ const { rows } = await db.query(`SELECT "userId","noteId",id,reaction FROM note_reaction WHERE "userId"=ANY($1) AND id>$2`, [impUserIds, sinceId]); for (const r of rows) pushHist(r.userId, r.noteId, String(r.reaction).includes(':') ? REACTION_RARE_WEIGHT : REACTION_NORMAL_WEIGHT, tsOf(r.id)); }
{ const { rows } = await db.query(`SELECT "userId","noteId",id FROM note_favorite WHERE "userId"=ANY($1) AND id>$2`, [impUserIds, sinceId]); for (const r of rows) pushHist(r.userId, r.noteId, FAVORITE_WEIGHT, tsOf(r.id)); }
{ const { rows } = await db.query(`SELECT "userId","renoteId","replyId",id FROM note WHERE "userId"=ANY($1) AND id>$2 AND ("renoteId" IS NOT NULL OR "replyId" IS NOT NULL)`, [impUserIds, sinceId]); for (const r of rows) { if (r.renoteId) pushHist(r.userId, r.renoteId, RENOTE_WEIGHT, tsOf(r.id)); if (r.replyId) pushHist(r.userId, r.replyId, REPLY_WEIGHT, tsOf(r.id)); } }
for (const [, h] of history) h.sort((a, b) => a.ts - b.ts);
const histNoteIds = [...new Set([...history.values()].flat().map(e => e.noteId))];

// Milvus note vectors (impression + history notes), tagging modality
async function milvusFetch(coll, ids) {
	const out = [];
	for (let i = 0; i < ids.length; i += 200) {
		const chunk = ids.slice(i, i + 200);
		const res = await fetch(`${MILVUS}/entities/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MTOKEN}` },
			body: JSON.stringify({ collectionName: coll, filter: `noteId in [${chunk.map(id => `"${id}"`).join(', ')}]`, outputFields: ['noteId', 'vector'], limit: chunk.length }) });
		const j = await res.json();
		if (j.code !== 0 && j.code !== 200) throw new Error(`Milvus ${j.code}: ${j.message}`);
		for (const r of (j.data ?? [])) if (typeof r.noteId === 'string' && Array.isArray(r.vector)) out.push(r);
	}
	return out;
}
const wantVec = [...new Set([...impNoteIds, ...histNoteIds])];
const noteVec = new Map();
for (const mod of ['mm', 'txt']) { for (const r of await milvusFetch(COLL[mod], wantVec)) if (!noteVec.has(r.noteId)) noteVec.set(r.noteId, { mod, v: r.vector }); }
console.log(`note vectors fetched: ${noteVec.size}/${wantVec.length}`);

// per-user timeline replay → authorSim + re-derived annScore per impression
const recon = new Map();
const impsByUser = new Map();
for (const i of imps) { if (!impsByUser.has(i.userId)) impsByUser.set(i.userId, []); impsByUser.get(i.userId).push(i); }
const annPairs = [];
for (const [uid, uimps] of impsByUser) {
	uimps.sort((a, b) => a.pushed_ms - b.pushed_ms);
	const hist = history.get(uid) ?? [];
	const uvec = { mm: null, txt: null };
	let hi = 0;
	for (const im of uimps) {
		while (hi < hist.length && hist[hi].ts < im.pushed_ms) {
			const e = hist[hi++]; const nvm = noteVec.get(e.noteId);
			if (nvm) { const a = Math.min(0.5, EMA_ALPHA * e.weight); let v = uvec[nvm.mod];
				if (v == null) v = nvm.v.slice(); else for (let d = 0; d < v.length; d++) v[d] = (1 - a) * v[d] + a * nvm.v[d];
				const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; uvec[nvm.mod] = v.map(x => x / n); }
		}
		const nvm = noteVec.get(im.noteId); const meta = noteMeta.get(im.noteId);
		if (!nvm || !meta) continue;
		const uv = uvec[nvm.mod]; if (!uv) continue;
		const noteSim = clamp01(cosine(uv, nvm.v));
		const cen = centroid[nvm.mod].get(meta.authorId);
		const authorSim = cen ? clamp01(cosine(uv, cen)) : noteSim;
		recon.set(im.id, { authorSim, annRederived: noteSim });
		if (im.annScore != null) annPairs.push([im.annScore, noteSim]);
	}
}
let mae = 0, corr = NaN;
if (annPairs.length) {
	mae = annPairs.reduce((s, p) => s + Math.abs(p[0] - p[1]), 0) / annPairs.length;
	const mx = annPairs.reduce((s, p) => s + p[0], 0) / annPairs.length, my = annPairs.reduce((s, p) => s + p[1], 0) / annPairs.length;
	let sxy = 0, sx = 0, sy = 0; for (const [x, y] of annPairs) { sxy += (x - mx) * (y - my); sx += (x - mx) ** 2; sy += (y - my) ** 2; }
	corr = sxy / (Math.sqrt(sx * sy) || 1);
}
console.log(`\nREPLAY VALIDATION — re-derived annScore vs stored serve-time annScore:`);
console.log(`  n=${annPairs.length}  mean|Δ|=${mae.toFixed(3)}  pearson=${corr.toFixed(3)}   (high corr / low Δ ⇒ replay faithful ⇒ authorScore trustworthy)`);
console.log(`reconstructed authorScore for ${recon.size}/${imps.length} impressions (rest: note vector evicted or cold user)`);

// assemble fill values per row
const recencyFromAge = h => RECENCY_FLOOR + (1 - RECENCY_FLOOR) * (h <= RECENCY_PLATEAU_HOURS ? 1 : Math.pow(0.5, (h - RECENCY_PLATEAU_HOURS) / RECENCY_DECAY_HALF_LIFE_HOURS));
const updates = [];
for (const i of imps) {
	const meta = noteMeta.get(i.noteId);
	const rc = recon.get(i.id);
	const fallback = i.score == null;
	const f = featOf.get(i.noteId);
	// Extended feature columns (popularity / structural penalties / topic / cfHit). Computed from note
	// metadata + rec:feat + the user's topic-interest array; COALESCE never clobbers a real serve-time value.
	const isImg = !!(meta?.hasImage);
	const readableLen = f?.readableLength;
	const shortness = (isImg || readableLen == null) ? (isImg ? 0 : null) : clamp01(1 - clamp01((lengthReward(readableLen) - LEN_FLOOR) / (1 - LEN_FLOOR)));
	const overTag = meta == null ? null : (meta.tagCount <= TAG_SOFT_MAX ? 0 : Math.min(1, (meta.tagCount - TAG_SOFT_MAX) / TAG_PENALTY_RANGE));
	const isReply = meta == null ? null : !!(meta.replyId != null && meta.replyUserId !== meta.authorId);
	const topic = noteTopic.get(i.noteId);
	const topicInterest = topic != null ? (Number(topicInterestOf.get(i.userId)?.[topic]) || 0) : 0;
	updates.push({
		id: i.id,
		author: rc ? rc.authorSim : null,            // COALESCE: fills the all-null column; null where no replay
		cf: 0,                                        // CF never fired → faithful 0 (COALESCE keeps any real value)
		ann: fallback ? 0 : i.annScore,               // fallback not ANN-retrieved → 0; snapshot value preserved by COALESCE
		quality: fallback ? (f == null ? 0 : (f.q != null ? llmTo01(f.q) : f.sq)) : i.qualityScore,
		recency: fallback ? (meta ? recencyFromAge((i.pushed_ms - meta.createdMs) / 3.6e6) : null) : i.recencyScore,
		langw: fallback ? BASE_SELECTED_LANG : i.langWeight,
		followed: fallback ? !!(meta && followees.get(i.userId)?.has(meta.authorId)) : i.followed,
		mm: fallback ? isImg : i.isMultimodal,
		popularity: meta?.popularity ?? null,
		shortness,
		overtag: overTag,
		isreply: isReply,
		topicint: topicInterest,
		cfhit: false,                                 // CF wasn't a source in this window → faithful false
	});
}

if (DRY) {
	const wAuthor = updates.filter(u => u.author != null).length;
	console.log(`\n[DRY RUN] would set authorScore on ${wAuthor} rows, cfScore=0 on all, and backfill ${imps.filter(i => i.score == null).length} fallback rows. No write performed.`);
} else {
	// batched UPDATE ... FROM (VALUES ...); COALESCE preserves real serve-time snapshots
	let written = 0;
	for (let i = 0; i < updates.length; i += 500) {
		const chunk = updates.slice(i, i + 500);
		const params = []; const tuples = [];
		for (const u of chunk) {
			const b = params.length;
			params.push(u.id, u.author, u.cf, u.ann, u.quality, u.recency, u.langw, u.followed, u.mm, u.popularity, u.shortness, u.overtag, u.isreply, u.topicint, u.cfhit);
			tuples.push(`($${b + 1},$${b + 2}::real,$${b + 3}::real,$${b + 4}::real,$${b + 5}::real,$${b + 6}::real,$${b + 7}::real,$${b + 8}::boolean,$${b + 9}::boolean,$${b + 10}::real,$${b + 11}::real,$${b + 12}::real,$${b + 13}::boolean,$${b + 14}::real,$${b + 15}::boolean)`);
		}
		const res = await db.query(`
			UPDATE note_recommendation_impression t SET
				"authorScore"     = COALESCE(t."authorScore",     v.author),
				"cfScore"         = COALESCE(t."cfScore",         v.cf),
				"annScore"        = COALESCE(t."annScore",        v.ann),
				"qualityScore"    = COALESCE(t."qualityScore",    v.quality),
				"recencyScore"    = COALESCE(t."recencyScore",    v.recency),
				"langWeight"      = COALESCE(t."langWeight",      v.langw),
				"followed"        = COALESCE(t."followed",        v.followed),
				"isMultimodal"    = COALESCE(t."isMultimodal",    v.mm),
				"popularityScore" = COALESCE(t."popularityScore", v.popularity),
				"shortnessSignal" = COALESCE(t."shortnessSignal", v.shortness),
				"overTagSignal"   = COALESCE(t."overTagSignal",   v.overtag),
				"isReplySignal"   = COALESCE(t."isReplySignal",   v.isreply),
				"topicInterest"   = COALESCE(t."topicInterest",   v.topicint),
				"cfHit"           = COALESCE(t."cfHit",           v.cfhit)
			FROM (VALUES ${tuples.join(',')}) AS v(id, author, cf, ann, quality, recency, langw, followed, mm, popularity, shortness, overtag, isreply, topicint, cfhit)
			WHERE t.id = v.id`, params);
		written += res.rowCount;
	}
	console.log(`\nwrote feature updates to ${written} impression rows.`);
	const { rows: chk } = await db.query(`SELECT count("authorScore") author, count("annScore") ann, count("qualityScore") quality, count("popularityScore") popularity, count("topicInterest") topic FROM note_recommendation_impression`);
	console.log(`post-write coverage: authorScore=${chk[0].author} annScore=${chk[0].ann} quality=${chk[0].quality} popularity=${chk[0].popularity} topic=${chk[0].topic} (of ${imps.length})`);
}

await redis.quit(); await db.end();
