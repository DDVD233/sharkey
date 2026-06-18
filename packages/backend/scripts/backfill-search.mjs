/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-off backfill: index existing notes into Meilisearch.
 *
 * Reuses the app's DI container so config / IdService / repositories match
 * the real SearchService.indexNote logic exactly. Pushes documents in batches
 * directly to the Meilisearch client (the heavy indexing happens server-side),
 * with backpressure so we don't flood the remote task queue.
 *
 * Run from packages/backend:
 *   node ./scripts/backfill-search.mjs [--since=<noteId>] [--batch=2000]
 *
 * Safe to re-run / resume: pass --since=<lastId> printed in the progress output.
 */

import { NestFactory } from '@nestjs/core';
import { MainModule } from '../built/MainModule.js';
import { DI } from '../built/di-symbols.js';
import { IdService } from '../built/core/IdService.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	const m = a.match(/^--([^=]+)=(.*)$/);
	return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const BATCH = Number.parseInt(args.batch ?? '2000', 10);
const PENDING_HIGH = 60; // pause pushing when enqueued+processing tasks exceed this
let lastId = typeof args.since === 'string' ? args.since : '';

function ts() { return new Date().toISOString(); }
function log(msg) { process.stdout.write(`[${ts()}] ${msg}\n`); }

const app = await NestFactory.createApplicationContext(MainModule, { logger: ['error', 'warn'] });

const config = app.get(DI.config);
const notesRepository = app.get(DI.notesRepository);
const meilisearch = app.get(DI.meilisearch); // MeiliSearch client or null
const idService = app.get(IdService);

if (!meilisearch) {
	log('FATAL: Meilisearch is not configured (DI.meilisearch is null). Aborting.');
	await app.close();
	process.exit(1);
}

const scope = config.meilisearch?.scope ?? 'global';
const noteIndex = meilisearch.index(`${config.meilisearch?.index}---notes`);

const meiliBase = `${config.meilisearch?.ssl ? 'https' : 'http'}://${config.meilisearch?.host}:${config.meilisearch?.port}`;
const meiliHeaders = { Authorization: `Bearer ${config.meilisearch?.apiKey}` };

// matches SearchService.indexNote scope gate
function inScope(userHost) {
	if (scope === 'global') return true;
	if (scope === 'local') return userHost == null;
	if (Array.isArray(scope)) return userHost == null || scope.includes(userHost);
	return true;
}

async function waitForDrain() {
	// backpressure: don't let the remote enqueue grow unbounded
	for (;;) {
		try {
			const res = await fetch(`${meiliBase}/tasks?statuses=enqueued,processing&limit=0`, { headers: meiliHeaders });
			const body = await res.json();
			const pending = body.total ?? 0;
			if (pending <= PENDING_HIGH) return;
		} catch {
			return; // if the tasks endpoint hiccups, don't stall the backfill
		}
		await new Promise(r => setTimeout(r, 2000));
	}
}

// Exact COUNT over ~90M rows exceeds statement_timeout, so use the planner's
// estimate as a cheap, approximate denominator for the progress percentage.
let approxTotal = 0;
try {
	const est = await notesRepository.query(
		`SELECT reltuples::bigint AS est FROM pg_class WHERE relname = 'note'`,
	);
	approxTotal = Number(est?.[0]?.est ?? 0);
} catch { /* progress % is best-effort */ }

log(`Backfill starting. scope=${JSON.stringify(scope)} index=${noteIndex.uid} batch=${BATCH}`);
log(`Approx total notes in table: ~${approxTotal.toLocaleString()} (resuming from id > "${lastId || '∅'}")`);

let scanned = 0;
let pushed = 0;
let skipped = 0;
const startedAt = Date.now();

for (;;) {
	const notes = await notesRepository.createQueryBuilder('note')
		.where('note.visibility IN (:...vis)', { vis: ['home', 'public'] })
		.andWhere('(note.text IS NOT NULL OR note.cw IS NOT NULL)')
		.andWhere(lastId ? 'note.id > :lastId' : '1=1', { lastId })
		.orderBy('note.id', 'ASC')
		.limit(BATCH)
		.getMany();

	if (notes.length === 0) break;
	lastId = notes[notes.length - 1].id;
	scanned += notes.length;

	const docs = [];
	for (const note of notes) {
		if (!inScope(note.userHost)) { skipped++; continue; }
		docs.push({
			id: note.id,
			createdAt: idService.parse(note.id).date.getTime(),
			userId: note.userId,
			userHost: note.userHost,
			channelId: note.channelId,
			cw: note.cw,
			text: note.text,
			tags: note.tags,
			attachedFileTypes: note.attachedFileTypes,
		});
	}

	if (docs.length > 0) {
		await waitForDrain();
		await noteIndex.addDocuments(docs, { primaryKey: 'id' });
		pushed += docs.length;
	}

	const elapsed = (Date.now() - startedAt) / 1000;
	const rate = Math.round(scanned / elapsed);
	const pct = approxTotal ? ((scanned / approxTotal) * 100).toFixed(2) : '?';
	const etaMin = (approxTotal && rate) ? Math.round((approxTotal - scanned) / rate / 60) : '?';
	// only log every 20 batches to keep the tmux log readable
	if (scanned % (BATCH * 20) < BATCH) {
		log(`scanned=${scanned.toLocaleString()} (~${pct}%) pushed=${pushed.toLocaleString()} skipped=${skipped.toLocaleString()} rate=${rate}/s eta~${etaMin}min lastId=${lastId}`);
	}
}

log(`DONE. scanned=${scanned.toLocaleString()} pushed=${pushed.toLocaleString()} skipped=${skipped.toLocaleString()}`);
log('Note: Meilisearch keeps processing enqueued tasks after this exits; watch /stats numberOfDocuments to see it converge.');
await app.close();
process.exit(0);
