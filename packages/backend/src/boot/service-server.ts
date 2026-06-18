/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

// repo root, from packages/backend/built/boot
const repoRoot = resolve(_dirname, '../../../../');
const serviceDir = resolve(repoRoot, 'service-server');
const serviceEntry = resolve(serviceDir, 'app.py');

/**
 * Spawns and supervises the local "service server" (FastAPI: /detect language detection +
 * /classify spam). Runs once in the master process, so it lives inside the Sharkey pm2 process
 * — no Docker, no separate service to start. Returns a stop() that kills the child and prevents
 * restart, or null when nothing was started.
 */
export function startServiceServer(config: Config, parentLogger: Logger): (() => void) | null {
	const conf = config.serviceServer;
	if (!conf?.enabled) return null;

	const logger = parentLogger.createSubLogger('service-server', 'green');

	if (!existsSync(serviceEntry)) {
		logger.error(`Cannot start service server: ${serviceEntry} not found. Set serviceServer.enabled=false to suppress this.`);
		return null;
	}

	const pythonPath = conf.pythonPath ?? 'python3';
	const host = conf.host ?? '127.0.0.1';
	const port = String(conf.port ?? 3061);

	let child: ChildProcess | null = null;
	let stopped = false;
	let restartTimer: NodeJS.Timeout | null = null;

	const launch = (): void => {
		if (stopped) return;
		logger.info(`Starting service server (${pythonPath} ${serviceEntry}) on ${host}:${port}`);

		child = spawn(pythonPath, [serviceEntry], {
			cwd: serviceDir,
			env: {
				...process.env,
				SERVICE_HOST: host,
				SERVICE_PORT: port,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		child.stdout?.on('data', (data: Buffer) => logger.info(data.toString().trimEnd()));
		child.stderr?.on('data', (data: Buffer) => logger.warn(data.toString().trimEnd()));

		child.on('error', err => {
			logger.error(`Failed to spawn service server: ${err.message}`);
		});

		child.on('exit', (code, signal) => {
			child = null;
			if (stopped) return;
			logger.warn(`Service server exited (code=${code}, signal=${signal}); restarting in 5s`);
			restartTimer = setTimeout(launch, 5000);
		});
	};

	launch();

	return () => {
		stopped = true;
		if (restartTimer) clearTimeout(restartTimer);
		if (child && !child.killed) child.kill('SIGTERM');
	};
}
