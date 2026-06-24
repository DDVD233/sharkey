/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Dry-run topic classifier: samples ~N random recent public text notes and classifies each with the
 * REAL production prompt/parser (imported from built/core/rec-topics.js), then prints the per-post
 * assignment and the overall distribution. Read-only. Run `pnpm --filter backend build` first.
 *
 *   node packages/backend/scripts/classify-topics-sample.mjs [n] [days] [concurrency]
 */
import pg from 'pg';
import { TOPIC_SYSTEM_PROMPT, TOPIC_LABELS, TOPIC_FALLBACK, parseTopic } from '../built/core/rec-topics.js';
import { pg as PG } from './_config.mjs';
const SUPPORTED = ['zh', 'en', 'ja'];
const N = parseInt(process.argv[2] ?? '100', 10);
const DAYS = parseInt(process.argv[3] ?? '30', 10);
const CONC = parseInt(process.argv[4] ?? '8', 10);
const AID_EPOCH = 946684800000;
const MAX_TEXT_CHARS = 4000;

const cleanText = t => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_CHARS);

function resolveEndpoint(url) {
	const trimmed = String(url).replace(/\/+$/, '');
	if (/\/(chat\/completions|completions)$/.test(trimmed)) return trimmed;
	if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
	return `${trimmed}/v1/chat/completions`;
}

const db = new pg.Client(PG);
await db.connect();

const { rows: metaRows } = await db.query('SELECT "llmTranslateURL","llmTranslateModel","llmTranslateKey","translationTimeout" FROM meta');
const meta = metaRows[0] ?? {};
if (!meta.llmTranslateURL) { console.error('no llmTranslateURL configured in meta'); process.exit(1); }
const ENDPOINT = resolveEndpoint(meta.llmTranslateURL);
const MODEL = meta.llmTranslateModel ?? '';
const TIMEOUT = meta.translationTimeout ?? 30000;
console.log(`LLM: ${ENDPOINT}  model=${MODEL}  (English prompt, ${TOPIC_LABELS.length} topics)`);

const sinceId = Math.max(0, Date.now() - DAYS * 86400000 - AID_EPOCH).toString(36).padStart(8, '0');
const { rows: notes } = await db.query(`
	SELECT n.id, n.text, n.lang,
	       EXISTS (SELECT 1 FROM drive_file df WHERE df.id = ANY(n."fileIds") AND df.type LIKE 'image/%') AS has_image
	FROM note n JOIN "user" u ON u.id = n."userId"
	WHERE n.visibility = 'public' AND n."channelId" IS NULL AND u."isExplorable" = TRUE
	  AND n.text IS NOT NULL AND char_length(n.text) >= 8 AND n.lang = ANY($1) AND n.id > $2
	ORDER BY random() LIMIT $3`, [SUPPORTED, sinceId, N]);
console.log(`sampled ${notes.length} notes (last ${DAYS}d, langs=${SUPPORTED.join('/')})\n`);

async function classify(text) {
	const body = JSON.stringify({
		model: MODEL,
		messages: [
			{ role: 'system', content: TOPIC_SYSTEM_PROMPT },
			{ role: 'user', content: `Post:\n\n${text}\n\nTopic:` },
		],
		temperature: 0, max_tokens: 16, stream: false,
		chat_template_kwargs: { enable_thinking: false },
	});
	const headers = { 'Content-Type': 'application/json', Accept: 'application/json, */*' };
	if (meta.llmTranslateKey) headers.Authorization = `Bearer ${meta.llmTranslateKey}`;
	const res = await fetch(ENDPOINT, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = await res.json();
	return json.choices?.[0]?.message?.content ?? '';
}

const results = new Array(notes.length);
let next = 0;
async function worker() {
	for (;;) {
		const i = next++;
		if (i >= notes.length) return;
		const n = notes[i];
		try {
			const raw = await classify(cleanText(n.text));
			results[i] = { n, raw: raw.replace(/\s+/g, ' ').trim(), topic: parseTopic(raw), fellBack: parseTopic(raw) == null };
		} catch (e) {
			results[i] = { n, raw: `ERR:${e.message}`, topic: null, err: true };
		}
	}
}
await Promise.all(Array.from({ length: CONC }, worker));

const snip = t => cleanText(t).slice(0, 64);
console.log('  #  lang img  topic              raw            text');
results.forEach((r, i) => {
	const eff = r.err ? 'ERR' : (r.topic ?? `${TOPIC_FALLBACK}*`); // * = unparsed → would fall back
	console.log(`${String(i + 1).padStart(3)}  ${String(r.n.lang ?? '∅').padEnd(4)} ${r.n.has_image ? 'Y' : '·'}   ` +
		`${eff.padEnd(16)} ${r.raw.slice(0, 12).padEnd(13)}  ${snip(r.n.text)}`);
});

const counts = {};
let errs = 0, fellBack = 0;
for (const r of results) {
	if (r.err) { errs++; continue; }
	const eff = r.topic ?? TOPIC_FALLBACK;
	if (r.topic == null) fellBack++;
	counts[eff] = (counts[eff] ?? 0) + 1;
}
const denom = results.length - errs || 1;
console.log(`\n=== DISTRIBUTION (n=${results.length}, errors=${errs}, fell back to ${TOPIC_FALLBACK}=${fellBack}) ===`);
for (const [label, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
	console.log(`${label.padEnd(16)} ${String(c).padStart(3)}  ${(100 * c / denom).toFixed(0).padStart(3)}%  ${'█'.repeat(Math.round(c / 2))}`);
}
const used = new Set(Object.keys(counts));
const unused = TOPIC_LABELS.filter(l => !used.has(l));
if (unused.length) console.log(`\nnever assigned: ${unused.join(', ')}`);
console.log(`image posts in sample: ${results.filter(r => r.n.has_image).length} (TEXT-ONLY here; production sends images)`);

await db.end();
