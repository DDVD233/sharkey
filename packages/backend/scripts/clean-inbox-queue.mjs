/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * One-off operational cleanup for the inbox queue.
 * - Reports current state
 * - Cleans terminal `failed` jobs
 * - Promotes `delayed` jobs so they run now (transient ones succeed; permanent ones
 *   continue their normal 8-retry lifecycle and drop on their own).
 * DRY_RUN=1 to only report.
 */
import { Queue } from 'bullmq';
import { redisConnection, queuePrefix } from './_config.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';

const connection = {
	...redisConnection,
	maxRetriesPerRequest: null,
};

// Mirror baseQueueOptions(): prefix = `${redis.prefix}:queue:${queueName}`, name = queueName
const queue = new Queue('inbox', { connection, prefix: `${queuePrefix}:inbox` });

const before = await queue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed', 'paused');
console.log('BEFORE:', JSON.stringify(before));

if (DRY_RUN) {
	console.log('DRY_RUN: no changes made.');
	await queue.close();
	process.exit(0);
}

// 1. Clean terminal failed jobs (grace 0 = all, limit huge).
const cleanedFailed = await queue.clean(0, 100000, 'failed');
console.log(`Cleaned failed jobs: ${cleanedFailed.length}`);

// 2. Promote delayed jobs to run immediately.
let promoted = 0;
// promoteJobs() (BullMQ >=4) promotes all delayed at once if available; fall back to per-job.
if (typeof queue.promoteJobs === 'function') {
	await queue.promoteJobs();
	promoted = before.delayed;
} else {
	const delayed = await queue.getJobs(['delayed'], 0, 100000);
	for (const job of delayed) {
		try { await job.promote(); promoted++; } catch (e) { /* job may have moved */ }
	}
}
console.log(`Promoted delayed jobs: ${promoted}`);

const after = await queue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed', 'paused');
console.log('AFTER:', JSON.stringify(after));

await queue.close();
process.exit(0);
