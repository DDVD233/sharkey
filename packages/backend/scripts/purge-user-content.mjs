/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-off moderation tool: purge ALL notes and drive files of a single user.
 *
 * Reuses the app's DI container so deletion goes through NoteDeleteService /
 * DriveService exactly like the real server: search index is cleaned up, charts
 * and counters are decremented, "deleted" events are streamed to clients, and AP
 * logs are removed. For a REMOTE user no Delete activity is federated outward
 * (the outbound branch is gated on isLocalUser), so this only purges the content
 * from our own instance.
 *
 * Run from packages/backend:
 *   node ./scripts/purge-user-content.mjs --user=<userId>            # dry run (default)
 *   node ./scripts/purge-user-content.mjs --user=<userId> --execute  # actually delete
 *
 * Safety: pass --expect-host=<host> and/or --expect-username=<usernameLower> to
 * abort unless the resolved user matches. Re-runnable / resumable.
 */

import { NestFactory } from '@nestjs/core';
import { MainModule } from '../built/MainModule.js';
import { DI } from '../built/di-symbols.js';
import { NoteDeleteService } from '../built/core/NoteDeleteService.js';
import { DriveService } from '../built/core/DriveService.js';
import { UserSuspendService } from '../built/core/UserSuspendService.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
	const m = a.match(/^--([^=]+)=(.*)$/);
	return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

const USER_ID = typeof args.user === 'string' ? args.user : null;
const EXECUTE = args.execute === true;
const EXPECT_HOST = typeof args['expect-host'] === 'string' ? args['expect-host'] : null;
const EXPECT_USERNAME = typeof args['expect-username'] === 'string' ? args['expect-username'] : null;
const BATCH = Number.parseInt(args.batch ?? '100', 10);
const SUSPEND = args.suspend === true;
const MODERATOR_ID = typeof args.moderator === 'string' ? args.moderator : null;

function ts() { return new Date().toISOString(); }
function log(msg) { process.stdout.write(`[${ts()}] ${msg}\n`); }

// In a bare application context the web server was never started, so some
// onApplicationShutdown hooks (e.g. the streaming WS server) throw on close.
// We're exiting anyway, so swallow those.
async function shutdown(code) {
	try { await app.close(); } catch { /* ignore shutdown-hook noise */ }
	process.exit(code);
}

if (!USER_ID) {
	log('FATAL: --user=<userId> is required.');
	process.exit(1);
}

const app = await NestFactory.createApplicationContext(MainModule, { logger: ['error', 'warn'] });

const usersRepository = app.get(DI.usersRepository);
const notesRepository = app.get(DI.notesRepository);
const driveFilesRepository = app.get(DI.driveFilesRepository);
const noteDeleteService = app.get(NoteDeleteService);
const driveService = app.get(DriveService);
const userSuspendService = app.get(UserSuspendService);

// usernameLower has `select: false`, so explicitly request it.
const user = await usersRepository.createQueryBuilder('user')
	.addSelect('user.usernameLower')
	.where('user.id = :id', { id: USER_ID })
	.getOne();
if (!user) {
	log(`FATAL: no user with id '${USER_ID}'.`);
	await shutdown(1);
}

log(`Target: @${user.usernameLower}@${user.host ?? '(local)'}  id=${user.id}  uri=${user.uri ?? '(local)'}`);

if (EXPECT_HOST != null && (user.host ?? '').toLowerCase() !== EXPECT_HOST.toLowerCase()) {
	log(`FATAL: host mismatch — expected '${EXPECT_HOST}', got '${user.host}'. Aborting.`);
	await shutdown(1);
}
if (EXPECT_USERNAME != null && user.usernameLower !== EXPECT_USERNAME.toLowerCase()) {
	log(`FATAL: username mismatch — expected '${EXPECT_USERNAME}', got '${user.usernameLower}'. Aborting.`);
	await shutdown(1);
}

const noteCount = await notesRepository.countBy({ userId: user.id });
const fileCount = await driveFilesRepository.countBy({ userId: user.id });
log(`Found ${noteCount} note(s) and ${fileCount} drive file(s) for this user.`);

if (!EXECUTE) {
	log(`DRY RUN — nothing ${SUSPEND ? 'suspended/' : ''}deleted. Re-run with --execute to perform the purge.`);
	await shutdown(0);
}

// --- suspend (stop new inbound content) -------------------------------------
// For a remote user this only flips isSuspended + drops their future inbound
// activity locally; the outbound Delete branch is gated on isLocalUser, so
// nothing is federated to their home server. Reversible via admin/unsuspend.
if (SUSPEND) {
	if (!user.isSuspended) {
		const moderator = MODERATOR_ID
			? await usersRepository.findOneBy({ id: MODERATOR_ID })
			: null;
		if (!moderator) {
			log(`FATAL: --suspend requires a valid --moderator=<localUserId>.`);
			await shutdown(1);
		}
		await userSuspendService.suspend(user, moderator);
		log(`Suspended @${user.usernameLower}@${user.host} (moderator @${moderator.username}). Waiting for in-flight inbound to settle…`);
		await new Promise(r => setTimeout(r, 3000));
	} else {
		log('Already suspended — skipping suspend step.');
	}
}

// --- delete notes -----------------------------------------------------------
// Cursor by id so a note that fails to delete is skipped, never retried forever.
let cursor = '';
let notesDeleted = 0;
let notesFailed = 0;
for (;;) {
	const notes = await notesRepository.createQueryBuilder('note')
		.where('note.userId = :uid', { uid: user.id })
		.andWhere('note.id > :cursor', { cursor })
		.orderBy('note.id', 'ASC')
		.take(BATCH)
		.getMany();
	if (notes.length === 0) break;
	for (const note of notes) {
		cursor = note.id;
		try {
			await noteDeleteService.delete(user, note);
			notesDeleted++;
		} catch (e) {
			notesFailed++;
			log(`  note ${note.id} FAILED: ${e?.message ?? e}`);
		}
	}
	log(`  notes: ${notesDeleted} deleted, ${notesFailed} failed (cursor=${cursor})`);
}

// --- delete drive files -----------------------------------------------------
const files = await driveFilesRepository.findBy({ userId: user.id });
let filesDeleted = 0;
let filesFailed = 0;
for (const file of files) {
	try {
		// deleteFileSync awaits the object-storage deletion (the actual image),
		// but deletePostProcess fires the DB row delete WITHOUT awaiting it — so
		// we delete the row ourselves to guarantee it's gone before we exit.
		await driveService.deleteFileSync(file, false);
		await driveFilesRepository.delete(file.id);
		filesDeleted++;
	} catch (e) {
		filesFailed++;
		log(`  file ${file.id} FAILED: ${e?.message ?? e}`);
	}
}
log(`  files: ${filesDeleted} deleted, ${filesFailed} failed`);

log(`DONE. notes: ${notesDeleted} deleted / ${notesFailed} failed. files: ${filesDeleted} deleted / ${filesFailed} failed.`);

await shutdown(0);
