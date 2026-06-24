/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Offline trainer for the LEARNED ("heavy") recommendation ranker. Mirrors Twitter's heavy ranker: it
 * trains one calibrated logistic head per ENGAGEMENT OUTCOME (reaction / favorite / renote / reply /
 * dwell / reply-engaged-by-author / dislike) over the full rank-time feature vector snapshotted in
 * note_recommendation_impression, then emits a model JSON the serving path combines as
 *     score = Σ_e  value_e · P(e | features)
 * with the per-engagement value weights configured in admin (rec-ranker.ts DEFAULT_ENGAGEMENT_VALUES).
 *
 * Run backfill-impression-features.mjs FIRST so the feature columns are filled. This script does no
 * vector work; it reads the impression columns + the engagement tables (for labels) + Redis (dislikes /
 * reply-engaged records). Re-runnable.
 *
 *   node packages/backend/scripts/learn-coef.mjs            # train + print model JSON + diagnostics
 *   node packages/backend/scripts/learn-coef.mjs --write    # also UPDATE meta.recommendationRankerModel
 *
 * After --write the running server picks the model up within ~5 min (MetaService periodic refresh) or on
 * restart. Ramp it in via the admin "learned ranker blend" (recommendationRankerWeight) — it starts at 0.
 */
import Redis from 'ioredis';
import pg from 'pg';
import { pg as PG, redis as REDIS } from './_config.mjs';

const WRITE = process.argv.includes('--write');
const AID_EPOCH = 946684800000;
const tsOf = id => parseInt(String(id).slice(0, 8), 36) + AID_EPOCH;
const LABEL_SLACK_MS = 60 * 60 * 1000;
const GOOD_DWELL_MS = 10_000; // dwell ≥ this counts as a "good click" positive (Twitter uses 2min; notes are shorter)
const MIN_POSITIVES = 15; // a head needs at least this many positive examples to be trained/emitted

// Feature order must match rec-ranker.ts RANKER_FEATURES; mapping → impression column.
const FEATURES = ['relevancy', 'authorAffinity', 'quality', 'popularity', 'recency', 'shortness', 'overTag', 'isReply', 'topic', 'followed', 'cfHit', 'mm', 'langW'];
const COL = { relevancy: 'annScore', authorAffinity: 'authorScore', quality: 'qualityScore', popularity: 'popularityScore', recency: 'recencyScore', shortness: 'shortnessSignal', overTag: 'overTagSignal', isReply: 'isReplySignal', topic: 'topicInterest', followed: 'followed', cfHit: 'cfHit', mm: 'isMultimodal', langW: 'langWeight' };
// Engagement outcomes the heads predict (must match rec-ranker.ts RANKER_ENGAGEMENTS).
const ENGAGEMENTS = ['reaction', 'favorite', 'renote', 'reply', 'dwell', 'replyEngagedByAuthor', 'dislike'];

const redis = new Redis(REDIS);
const db = new pg.Client(PG); await db.connect();

const { rows: imps } = await db.query(`
  SELECT id, "userId", "noteId", EXTRACT(EPOCH FROM "pushedAt")*1000 AS pushed_ms, rank, score, source,
         "annScore", "authorScore", "cfScore", "qualityScore", "recencyScore", "langWeight",
         "popularityScore", "shortnessSignal", "overTagSignal", "isReplySignal", "topicInterest", "cfHit",
         "dwellMs", alpha, "followed", "isMultimodal"
  FROM note_recommendation_impression`);
console.log(`loaded ${imps.length} impressions${WRITE ? '  [WILL WRITE MODEL]' : ''}`);
const impUserIds = [...new Set(imps.map(i => i.userId))];
const impNoteIds = [...new Set(imps.map(i => i.noteId))];

// ---- positive-outcome timestamps, per (user,note,kind) ----
const kindTs = { reaction: new Map(), favorite: new Map(), renote: new Map(), reply: new Map() };
const mark = (kind, uid, nid, ts) => { const k = `${uid}|${nid}`; const c = kindTs[kind].get(k); if (c == null || ts < c) kindTs[kind].set(k, ts); };
{ const { rows } = await db.query(`SELECT "userId","noteId",id FROM note_reaction WHERE "userId"=ANY($1) AND "noteId"=ANY($2)`, [impUserIds, impNoteIds]); for (const r of rows) mark('reaction', r.userId, r.noteId, tsOf(r.id)); }
{ const { rows } = await db.query(`SELECT "userId","noteId",id FROM note_favorite WHERE "userId"=ANY($1) AND "noteId"=ANY($2)`, [impUserIds, impNoteIds]); for (const r of rows) mark('favorite', r.userId, r.noteId, tsOf(r.id)); }
{ const { rows } = await db.query(`SELECT "userId","renoteId","replyId",id FROM note WHERE "userId"=ANY($1) AND ("renoteId"=ANY($2) OR "replyId"=ANY($2))`, [impUserIds, impNoteIds]);
	for (const r of rows) { if (r.renoteId) mark('renote', r.userId, r.renoteId, tsOf(r.id)); if (r.replyId) mark('reply', r.userId, r.replyId, tsOf(r.id)); } }

// ---- Redis note-level labels: dislikes (rec:disliked) + reply-engaged-by-author (rec:replyengaged) ----
const dislikedOf = new Map(); // userId → Set(noteId)
const replyEngagedOf = new Map();
{
	const pipe = redis.pipeline();
	for (const uid of impUserIds) { pipe.zrange(`rec:disliked:${uid}`, 0, -1); pipe.zrange(`rec:replyengaged:${uid}`, 0, -1); }
	const res = await pipe.exec();
	impUserIds.forEach((uid, i) => {
		dislikedOf.set(uid, new Set(res[i * 2]?.[1] ?? []));
		replyEngagedOf.set(uid, new Set(res[i * 2 + 1]?.[1] ?? []));
	});
}

// ---- assemble rows: feature vector + per-engagement labels ----
const num = (v, b = false) => v == null ? 0 : (b ? (v ? 1 : 0) : (Number(v) || 0));
const rows = imps.map(i => {
	const x = {};
	for (const f of FEATURES) { const c = COL[f]; const isBool = (f === 'isReply' || f === 'followed' || f === 'cfHit' || f === 'mm'); x[f] = num(i[c], isBool); }
	const key = `${i.userId}|${i.noteId}`;
	const within = (ts) => ts != null && ts >= i.pushed_ms - LABEL_SLACK_MS;
	const y = {
		reaction: within(kindTs.reaction.get(key)) ? 1 : 0,
		favorite: within(kindTs.favorite.get(key)) ? 1 : 0,
		renote: within(kindTs.renote.get(key)) ? 1 : 0,
		reply: within(kindTs.reply.get(key)) ? 1 : 0,
		dwell: (i.dwellMs != null && i.dwellMs >= GOOD_DWELL_MS) ? 1 : 0,
		replyEngagedByAuthor: replyEngagedOf.get(i.userId)?.has(i.noteId) ? 1 : 0,
		dislike: dislikedOf.get(i.userId)?.has(i.noteId) ? 1 : 0,
	};
	return { userId: i.userId, hasSnap: i.score != null, score: i.score, rank: i.rank, x, y };
}).filter(r => r.hasSnap); // train on faithful serve-time snapshots (fallback-tail rows have no real features)

console.log(`training rows (snapshot impressions): ${rows.length}`);
console.log('positives per engagement: ' + ENGAGEMENTS.map(e => `${e}=${rows.reduce((s, r) => s + r.y[e], 0)}`).join('  '));

// Admin value weights define what "good" means (Twitter's reply≫like, dislike strongly negative). Read
// the configured values from meta; fall back to the in-source defaults.
const VALUES = { reaction: 0.5, favorite: 1.0, renote: 1.0, reply: 13.5, dwell: 11.0, replyEngagedByAuthor: 75.0, dislike: -74.0 };
try {
	const { rows: mrows } = await db.query(`SELECT "recommendationEngagementValues" AS v FROM meta`);
	const ev = mrows[0]?.v ?? {};
	for (const e of ENGAGEMENTS) if (typeof ev[e] === 'number' && Number.isFinite(ev[e])) VALUES[e] = ev[e];
} catch { /* use defaults */ }
// Per-impression realized engagement value = Σ value_e · outcome_e. This is the regression target: the
// additive per-feature weights are fit to PREDICT this value from the features (missing features → 0).
const valueTarget = r => ENGAGEMENTS.reduce((s, e) => s + VALUES[e] * r.y[e], 0);

function standardiser(rs) {
	const mean = {}, std = {};
	for (const f of FEATURES) { const v = rs.map(r => r.x[f]); const m = v.reduce((s, x) => s + x, 0) / v.length; mean[f] = m; std[f] = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) || 1; }
	return { mean, std };
}

// ---- PRIMARY: ridge value-regression → signed additive per-feature weights (drives ranking) ----
function trainValueWeights(rs, { l2 = 2.0, lr = 0.05, iters = 6000 } = {}) {
	const { mean, std } = standardiser(rs);
	const z = r => FEATURES.map(f => (r.x[f] - mean[f]) / std[f]);
	const Z = rs.map(z), Y = rs.map(valueTarget);
	const n = rs.length;
	let w = FEATURES.map(() => 0), b = Y.reduce((s, v) => s + v, 0) / n;
	for (let it = 0; it < iters; it++) {
		const grad = FEATURES.map(() => 0); let gb = 0;
		for (let m = 0; m < n; m++) {
			let pred = b; for (let j = 0; j < FEATURES.length; j++) pred += w[j] * Z[m][j];
			const err = pred - Y[m];
			for (let j = 0; j < FEATURES.length; j++) grad[j] += err * Z[m][j];
			gb += err;
		}
		for (let j = 0; j < FEATURES.length; j++) w[j] -= lr * (grad[j] / n + l2 * w[j] / n);
		b -= lr * gb / n;
	}
	// de-standardize so the weights apply to RAW features (serving feeds raw signals).
	const weights = {};
	for (let j = 0; j < FEATURES.length; j++) weights[FEATURES[j]] = w[j] / std[FEATURES[j]];
	return weights;
}

// ---- pointwise logistic head per engagement (standardize → class-weighted GD → de-standardize) ----
function trainHead(rs, e, { l2 = 1.0, lr = 0.1, iters = 3000 } = {}) {
	const pos = rs.filter(r => r.y[e] === 1).length;
	if (pos < MIN_POSITIVES) return { skipped: true, pos };
	const neg = rs.length - pos;
	const { mean, std } = standardiser(rs);
	const z = r => FEATURES.map(f => (r.x[f] - mean[f]) / std[f]);
	const wPos = neg / Math.max(1, pos), wNeg = 1; // balance the rare positive class
	const sig = t => 1 / (1 + Math.exp(-t));
	let w = FEATURES.map(() => 0), b = 0;
	const Z = rs.map(z), Y = rs.map(r => r.y[e]), W = rs.map(r => (r.y[e] ? wPos : wNeg));
	let wsum = 0; for (const wi of W) wsum += wi;
	for (let it = 0; it < iters; it++) {
		const grad = FEATURES.map(() => 0); let gb = 0;
		for (let n = 0; n < Z.length; n++) {
			let d = b; for (let j = 0; j < FEATURES.length; j++) d += w[j] * Z[n][j];
			const g = (sig(d) - Y[n]) * W[n];
			for (let j = 0; j < FEATURES.length; j++) grad[j] += g * Z[n][j];
			gb += g;
		}
		for (let j = 0; j < FEATURES.length; j++) { w[j] -= lr * (grad[j] / wsum + l2 * w[j] / rs.length); }
		b -= lr * (gb / wsum);
	}
	// de-standardize so serving can apply directly to RAW features: z = b + Σ w_j·(x_j-mean_j)/std_j
	const weights = {}; let biasRaw = b;
	for (let j = 0; j < FEATURES.length; j++) { const f = FEATURES[j]; weights[f] = w[j] / std[f]; biasRaw -= w[j] * mean[f] / std[f]; }
	return { skipped: false, pos, neg, bias: biasRaw, weights };
}

// PRIMARY model: additive per-feature weights (drive ranking + the "why recommended?" factor table).
const weights = trainValueWeights(rows);
console.log(`\n${'='.repeat(78)}\nLEARNED ADDITIVE WEIGHTS (signed; value-regression target Σ value·outcome; sorted by |magnitude|)`);
for (const [f, w] of FEATURES.map(f => [f, weights[f]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
	console.log(`    ${f.padEnd(16)} ${w >= 0 ? ' ' : ''}${w.toFixed(4)}`);
}

// SECONDARY: per-engagement logistic heads — DISPLAY ONLY (the "predicted engagement" insight panel).
const heads = {};
console.log(`\nLEARNED ENGAGEMENT HEADS (display-only; raw-feature logistic)`);
for (const e of ENGAGEMENTS) {
	const h = trainHead(rows, e);
	if (h.skipped) { console.log(`  ${e.padEnd(22)} SKIPPED (only ${h.pos} positives < ${MIN_POSITIVES})`); continue; }
	heads[e] = { bias: h.bias, weights: h.weights };
	const top = FEATURES.map(f => [f, h.weights[f]]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
	console.log(`  ${e.padEnd(22)} pos=${String(h.pos).padStart(5)} bias=${h.bias.toFixed(2).padStart(7)}  | ${top.map(([f, w]) => `${f}:${w.toFixed(2)}`).join('  ')}`);
}

const model = { version: 2, features: FEATURES, weights, heads, trainedAt: new Date().toISOString() };
const modelJson = JSON.stringify(model);

// ---- diagnostics: within-user AUC of the additive learned model vs. the production score ----
// The additive serving score is Σ_f weights[f]·rawSignal[f]; evaluate that same linear predictor here.
const additivePred = r => FEATURES.reduce((s, f) => s + weights[f] * r.x[f], 0);
// "engaged" = any positive non-dislike outcome (a coarse overall label for the AUC sanity check).
const engaged = r => (r.y.reaction || r.y.favorite || r.y.renote || r.y.reply || r.y.dwell || r.y.replyEngagedByAuthor) ? 1 : 0;
function macroAUC(valueFn) {
	const byU = new Map();
	for (const r of rows) { if (!byU.has(r.userId)) byU.set(r.userId, { pos: [], neg: [] }); (engaged(r) ? byU.get(r.userId).pos : byU.get(r.userId).neg).push(r); }
	const per = [];
	for (const [, g] of byU) { if (!g.pos.length || !g.neg.length) continue; let conc = 0, tot = 0; for (const p of g.pos) for (const n of g.neg) { const a = valueFn(p), b = valueFn(n); tot++; conc += a > b ? 1 : a === b ? 0.5 : 0; } per.push(conc / tot); }
	return per.length ? per.reduce((s, v) => s + v, 0) / per.length : NaN;
}
console.log(`\nwithin-user AUC (overall engaged):  learned-additive=${macroAUC(additivePred).toFixed(3)}   production-score=${macroAUC(r => r.score ?? 0).toFixed(3)}   position=${macroAUC(r => -(r.rank ?? 0)).toFixed(3)}`);

console.log(`\n${'='.repeat(78)}\nMODEL JSON (paste into admin → Recommendation → learned ranker model, or use --write):\n${modelJson}`);

if (WRITE) {
	await db.query(`UPDATE "meta" SET "recommendationRankerModel"=$1`, [modelJson]);
	console.log(`\nwrote model to meta.recommendationRankerModel (${FEATURES.length} additive weights, ${Object.keys(heads).length} display heads). The server refreshes meta within ~5min; ramp recommendationRankerWeight up from 0 to take effect.`);
}

await redis.quit(); await db.end();
