/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { SpamFilterService } from '@/core/SpamFilterService.js';
import { bindThis } from '@/decorators.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { SpamCheckJobData } from '../types.js';

@Injectable()
export class SpamCheckProcessorService {
	private logger: Logger;

	constructor(
		private spamFilterService: SpamFilterService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('spam-check');
	}

	@bindThis
	public async process(job: Bull.Job<SpamCheckJobData>): Promise<void> {
		if (job.data.profileUserId != null) {
			await this.spamFilterService.checkProfile(job.data.profileUserId);
		} else if (job.data.noteId != null) {
			await this.spamFilterService.checkNote(job.data.noteId);
		}
	}
}
