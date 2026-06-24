/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Recommendation feed — integration test.
 *
 * This is NOT a Jest unit test: the recommendation feed's quality metrics (mean score, topic
 * diversity) only mean something against REAL embeddings (Milvus), LLM quality/topic scores, and
 * interaction history — none of which exist in the empty Jest test DB. So this boots the ACTUAL
 * backend DI context against the live config and drives the REAL `RecommendationService` public
 * methods, asserting on what the real code returns. It never reimplements any recommendation logic.
 *
 *   node packages/backend/test/recommendation/feed.integration.mjs
 *   (or: pnpm --filter backend test:recommendation)
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 *
 * Two scenarios, driven by two local accounts (auto-detected by reaction history):
 *   • COLD  — a user with zero interactions (no interest vector); exercises the cold-start path.
 *   • WARM  — a user with real interaction history (interest vector); exercises personalization.
 * Setup is idempotent: WARM is (re)seeded from its durable Postgres history via the real
 * `backfillUserFromHistory`; COLD has its recommendation state cleared so it is genuinely new.
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import Redis from 'ioredis';
import { IsNull } from 'typeorm';
import { GlobalModule } from '../../built/GlobalModule.js';
import { CoreModule } from '../../built/core/CoreModule.js';
import { RecommendationService } from '../../built/core/RecommendationService.js';
import { DI } from '../../built/di-symbols.js';

// Local test accounts. WARM must have interaction history; COLD is cleared to zero interactions.
const WARM_ACCT = 'bvd';
const COLD_ACCT = 'ddvd2334';
const LIMIT = 15;
const MIN_MEAN_SCORE = 0.3;   // mean recommendation score of the first page must clear this
const MIN_TOPICS = 3;         // the page must span at least this many distinct topics
const MIN_DISCOVERY = 3;      // at least this many score-ranked (non-follows) notes must be present

const results = [];
const check = (scenario, name, pass, detail = '') => results.push({ scenario, name, pass: !!pass, detail });

const app = await NestFactory.createApplicationContext(
	(() => { class M {} Module({ imports: [GlobalModule, CoreModule] })(M); return M; })(),
	{ logger: ['error'] },
);
const rec = app.get(RecommendationService);
const usersRepository = app.get(DI.usersRepository);
const config = app.get(DI.config);
const prefix = config.redisForTimelines.keyPrefix ?? '';
const redis = new Redis({ ...config.redisForTimelines, keyPrefix: undefined });

const resolveId = async (username) => {
	const u = await usersRepository.findOneBy({ usernameLower: username.toLowerCase(), host: IsNull() });
	if (u == null) throw new Error(`local account @${username} not found`);
	return u.id;
};
const clearKeys = async (pattern) => { const ks = await redis.keys(pattern); if (ks.length) await redis.del(...ks); return ks.length; };
const hasInterestVector = async (id) => {
	const [mm, txt] = await Promise.all([redis.exists(`${prefix}rec:uvec:mm:${id}`), redis.exists(`${prefix}rec:uvec:txt:${id}`)]);
	return mm > 0 || txt > 0;
};

async function runScenario({ label, username, mode }) {
	const id = await resolveId(username);

	// --- setup (uses only real service methods + state clears; no logic reimplemented) ---
	if (mode === 'warm') {
		// Rebuild the interest model from the account's durable engagement history (idempotent).
		const seeded = await rec.backfillUserFromHistory(id);
		await clearKeys(`${prefix}rec:queue:${id}*`); await clearKeys(`${prefix}rec:pushed:${id}`); // fresh, deterministic pull
		check(label, 'setup: seeded interest model from real history', seeded > 0, `engagedNotes=${seeded}`);
		check(label, 'setup: account is genuinely warm (has interest vector)', await hasInterestVector(id));
	} else {
		const cleared = await clearKeys(`${prefix}rec:*${id}*`); // wipe all rec state → genuinely new user
		check(label, 'setup: account is genuinely cold (no interest vector)', !(await hasInterestVector(id)), `clearedKeys=${cleared}`);
	}

	// --- pull the first page through the REAL serve path ---
	const langs = await rec.resolveLangs(id, null);
	const { notes, breakdowns } = await rec.getPage(id, langs, LIMIT, true, 0);

	const withB = notes.filter(n => breakdowns.has(n.id));
	const all = withB.map(n => breakdowns.get(n.id));
	const discovery = all.filter(b => b.type === 'score');
	const scores = discovery.map(b => b.score);
	const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
	const topics = new Set(all.map(b => b.topic).filter(Boolean));

	// 1. Pulling notes works.
	check(label, 'pulls a full page of notes', notes.length >= Math.min(10, LIMIT), `got ${notes.length}/${LIMIT}`);
	// 2. Discovery is active (not just the follows lane) — proves ANN/CF/HQ retrieval produced candidates.
	check(label, `discovery produced >= ${MIN_DISCOVERY} score-ranked notes`, discovery.length >= MIN_DISCOVERY, `score-ranked=${discovery.length}`);
	// 3. Mean recommendation score of the page clears the quality floor.
	check(label, `mean recommendation score >= ${MIN_MEAN_SCORE}`, mean >= MIN_MEAN_SCORE, `mean=${mean.toFixed(3)} (n=${scores.length})`);
	// 4. Topic diversity — the page is not dominated by one or two topics.
	check(label, `topic diversity >= ${MIN_TOPICS} distinct topics`, topics.size >= MIN_TOPICS, `${topics.size}: {${[...topics].join(', ')}}`);
	// 5. No duplicate notes on the page.
	const ids = notes.map(n => n.id);
	check(label, 'no duplicate notes on the page', new Set(ids).size === ids.length, `${ids.length} ids, ${new Set(ids).size} unique`);
	// 6. Every score is a sane, finite, non-negative number.
	check(label, 'all scores finite and >= 0', scores.length > 0 && scores.every(s => Number.isFinite(s) && s >= 0), `min=${scores.length ? Math.min(...scores).toFixed(3) : 'n/a'}`);
	// 7. Language adherence — the feed respects the resolved languages (allowing undetected-language notes).
	const langSet = new Set(langs);
	const inLang = notes.filter(n => n.lang == null || langSet.has(rec.normalizeLang(n.lang))).length;
	check(label, 'language adherence >= 70%', notes.length > 0 && inLang / notes.length >= 0.7, `${inLang}/${notes.length} in [${langs}]∪null`);
	// 8. The feed advances on refresh — a second pull does not just repeat the first (pushed-dedup works).
	const page2 = await rec.getPage(id, langs, LIMIT, true, 0);
	const seen1 = new Set(ids);
	const overlap = page2.notes.filter(n => seen1.has(n.id)).length;
	check(label, 'refresh advances the feed (<50% overlap)', page2.notes.length > 0 && overlap / page2.notes.length < 0.5, `overlap ${overlap}/${page2.notes.length}`);

	console.log(`\n[${label} @${username}] langs=[${langs}] notes=${notes.length} discovery=${discovery.length} meanScore=${mean.toFixed(3)} topics=${topics.size} {${[...topics].join(', ')}}`);
}

let failed = false;
try {
	// Auto-detect which account is warm/cold (be resilient if the roles are swapped on this instance).
	const warmId = await resolveId(WARM_ACCT);
	const warmReactions = await app.get(DI.notesRepository).manager.query('SELECT count(*)::int AS c FROM note_reaction WHERE "userId" = $1', [warmId]).then(r => r[0].c);
	const [warm, cold] = warmReactions > 0 ? [WARM_ACCT, COLD_ACCT] : [COLD_ACCT, WARM_ACCT];

	await runScenario({ label: 'COLD', username: cold, mode: 'cold' });
	await runScenario({ label: 'WARM', username: warm, mode: 'warm' });
} catch (e) {
	console.error('\nFATAL:', e?.stack ?? e);
	failed = true;
} finally {
	// --- report ---
	console.log('\n──────────────────────────────────────────── results ────────────────────────────────────────────');
	let pass = 0;
	for (const r of results) {
		console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  [${r.scenario}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
		if (r.pass) pass++; else failed = true;
	}
	console.log(`──────────────────────────────────────────────────────────────────────────────────────────────────`);
	console.log(`${pass}/${results.length} checks passed`);
	await app.close();
	redis.disconnect();
	process.exit(failed ? 1 : 0);
}
