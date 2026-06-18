/*
 * Benchmark spamscanner (https://github.com/spamscanner/spamscanner) on the same note
 * sample used by eval_spam.py, so we can compare it against the VLM classifier.
 *
 * spamscanner's programmatic API exposes results.{classification,phishing,...} but not the
 * CLI score weights, so we compute the weighted score ourselves:
 *   classifier 5 (if category==spam) + phishing 5/issue + executable 10 + macro 5
 *   + virus 100 + nsfw 0 (allowed) + toxicity 3/issue;   isSpam = score >= THRESHOLD (5).
 *
 * NSFW/toxicity need TensorFlow; left disabled here (nsfw weight is 0 anyway). The substance
 * for plain-text social posts is the Bayes classifier + phishing detection.
 *
 * Env: SAMPLE_FILE (/tmp/note_sample.jsonl), OUT_FILE (/tmp/spamscanner_positives.tsv),
 *      CONFIG_FILE (../../.config/default.yml), WORKERS (8), THRESHOLD (5)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import SpamScanner from 'spamscanner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_FILE = process.env.SAMPLE_FILE || '/tmp/note_sample.jsonl';
const OUT_FILE = process.env.OUT_FILE || '/tmp/spamscanner_positives.tsv';
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, '..', '..', '.config', 'default.yml');
const WORKERS = parseInt(process.env.WORKERS || '8', 10);
const THRESHOLD = parseFloat(process.env.THRESHOLD || '5');

const W = { classifier: 5, phishing: 5, executable: 10, macro: 5, virus: 100, nsfw: 0, toxicity: 3 };

let skipHosts = new Set();
try {
	const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
	skipHosts = new Set(cfg.spamFilterSkipHosts || []);
} catch (e) {
	console.error(`warning: could not read ${CONFIG_FILE}: ${e.message}`);
}

const notes = [];
let whitelisted = 0;
for (const line of fs.readFileSync(SAMPLE_FILE, 'utf8').split('\n')) {
	const s = line.trim();
	if (!s) continue;
	let o;
	try { o = JSON.parse(s); } catch { continue; }
	if (skipHosts.has(o.h)) { whitelisted++; continue; }
	notes.push(o);
}

const scanner = new SpamScanner();

function scoreOf(res) {
	let score = 0;
	if (res.classification && res.classification.category === 'spam') score += W.classifier;
	score += W.phishing * ((res.phishing || []).length);
	score += W.executable * ((res.executables || []).length);
	score += W.macro * ((res.macros || []).length);
	score += W.virus * ((res.viruses || []).length);
	score += W.nsfw * ((res.nsfw || []).length);
	score += W.toxicity * ((res.toxicity || []).length);
	return score;
}

async function classify(o) {
	const email = `From: a@example.com\nTo: b@example.com\nSubject: post\n\n${o.t || ''}`;
	const t0 = Date.now();
	try {
		const r = await scanner.scan(email);
		const score = scoreOf(r.results || {});
		return { o, score, prob: r.results?.classification?.probability ?? 0, lat: Date.now() - t0, err: null };
	} catch (e) {
		return { o, score: 0, prob: 0, lat: Date.now() - t0, err: String(e.message || e).slice(0, 120) };
	}
}

const flagged = [];
let errors = 0, done = 0;
const latencies = [];
const wall0 = Date.now();

// simple concurrency pool
let idx = 0;
async function worker() {
	while (idx < notes.length) {
		const o = notes[idx++];
		const r = await classify(o);
		done++;
		if (r.err) errors++;
		else {
			latencies.push(r.lat);
			if (r.score >= THRESHOLD) flagged.push([r.score, o.h, o.id, (o.t || '').replace(/[\n\t]/g, ' ').slice(0, 300)]);
		}
		if (done % 1000 === 0) {
			const el = (Date.now() - wall0) / 1000;
			console.error(`  ${done}/${notes.length}  flagged=${flagged.length}  err=${errors}  ${(done / el).toFixed(1)}/s`);
		}
	}
}

console.error(`scanning ${notes.length} notes with spamscanner (${WORKERS} workers); whitelisted_skipped=${whitelisted}`);
await Promise.all(Array.from({ length: WORKERS }, worker));
const wall = (Date.now() - wall0) / 1000;

flagged.sort((a, b) => b[0] - a[0]);
fs.writeFileSync(OUT_FILE, 'score\thost\tid\ttext\n' + flagged.map(r => `${r[0]}\t${r[1]}\t${r[2]}\t${r[3]}`).join('\n') + '\n');

const pct = (xs, p) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p / 100 * xs.length))] : 0;
const scanned = notes.length - errors;
const mean = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
console.log('\n=== SPAMSCANNER RESULTS ===');
console.log(`whitelisted_skipped: ${whitelisted}`);
console.log(`scanned_ok: ${scanned}  errors: ${errors}`);
console.log(`flagged (score>=${THRESHOLD}): ${flagged.length}  (${(100 * flagged.length / scanned).toFixed(2)}%)`);
console.log('--- performance ---');
console.log(`workers: ${WORKERS}  wall_clock: ${wall.toFixed(1)}s  throughput: ${(scanned / wall).toFixed(1)}/s`);
console.log(`latency: mean ${mean.toFixed(0)}ms  p50 ${pct(latencies, 50)}ms  p95 ${pct(latencies, 95)}ms`);
console.log(`positives -> ${OUT_FILE}`);
