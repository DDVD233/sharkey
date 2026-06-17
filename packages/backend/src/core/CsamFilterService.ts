/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiMeta, DriveFilesRepository, CsamDenylistRepository, CsamQuarantineRepository, UsersRepository } from '@/models/_.js';
import { AbuseReportService } from '@/core/AbuseReportService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

@Injectable()
export class CsamFilterService {
	private logger: Logger;

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.csamDenylistRepository)
		private csamDenylistRepository: CsamDenylistRepository,

		@Inject(DI.csamQuarantineRepository)
		private csamQuarantineRepository: CsamQuarantineRepository,

		private abuseReportService: AbuseReportService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('csam-filter');
	}

	@bindThis
	public async checkFile(fileId: string): Promise<void> {
		if (!this.meta.enableCsamFilter) return;

		const file = await this.driveFilesRepository.findOneBy({ id: fileId });
		if (file == null) return;
		if (!file.type.startsWith('image/')) return;
		if (file.isQuarantined) return;

		// Idempotency.
		if (await this.csamQuarantineRepository.existsBy({ fileId })) return;

		// Match the file's MD5 against the admin-controlled denylist.
		// NOTE: this only catches re-uploads of already-flagged images; novel CSAM coverage
		// relies on the Cloudflare edge tool. PhotoDNA was intentionally not integrated.
		const match = await this.csamDenylistRepository.findOneBy({ hashType: 'md5', hashValue: file.md5 });
		if (match == null) return;

		await this.quarantine(file, 'denylist', match.memo ?? 'matched CSAM MD5 denylist');
	}

	/**
	 * Quarantine a file: de-serve it, record evidence, and raise an urgent abuse report.
	 * Does NOT suspend the uploader — held for moderator review.
	 */
	@bindThis
	private async quarantine(file: { id: string; md5: string; userId: string | null; userHost: string | null }, source: 'denylist' | 'cloudflare' | 'manual', reason: string): Promise<void> {
		await this.driveFilesRepository.update(file.id, { isQuarantined: true });

		await this.csamQuarantineRepository.insert({
			id: this.idService.gen(),
			createdAt: new Date(),
			fileId: file.id,
			userId: file.userId,
			userHost: file.userHost,
			noteId: null,
			md5: file.md5,
			source,
			status: 'pending',
			reason,
		});

		this.logger.warn(`CSAM filter quarantined file ${file.id} (source=${source}, user=${file.userId ?? '<none>'})`);

		// Urgent admin alert via the abuse-report pipeline (best-effort).
		const moderatorId = this.meta.spamFilterModeratorUserId;
		if (moderatorId != null && file.userId != null) {
			try {
				await this.abuseReportService.report([{
					targetUserId: file.userId,
					targetUserHost: file.userHost,
					reporterId: moderatorId,
					reporterHost: null,
					comment: `[AUTOMATED CSAM DETECTION] File ${file.id} matched the CSAM ${source} (${reason}). The file has been quarantined (de-served) pending review. This requires immediate moderator attention and likely a CyberTipline (NCMEC) report.`,
				}]);
			} catch (err) {
				this.logger.error(`failed to raise CSAM abuse report for file ${file.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
}
