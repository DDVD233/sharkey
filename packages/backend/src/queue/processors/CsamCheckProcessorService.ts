/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { CsamFilterService } from '@/core/CsamFilterService.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { CsamCheckJobData } from '../types.js';

@Injectable()
export class CsamCheckProcessorService {
	private logger: Logger;

	constructor(
		private csamFilterService: CsamFilterService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('csam-check');
	}

	@bindThis
	public async process(job: Bull.Job<CsamCheckJobData>): Promise<void> {
		await this.csamFilterService.checkFile(job.data.fileId);
	}
}
