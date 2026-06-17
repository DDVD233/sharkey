/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { CsamQuarantineRepository, DriveFilesRepository, UsersRepository, MiMeta } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { UserSuspendService } from '@/core/UserSuspendService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:resolve-abuse-user-report',

	errors: {
		noSuchRecord: {
			message: 'No such quarantine record.',
			code: 'NO_SUCH_RECORD',
			id: 'a1b2c3d4-0000-0000-0000-000000000001',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		id: { type: 'string', format: 'misskey:id' },
		// confirm = real CSAM (keep file de-served as evidence, optionally suspend uploader)
		// dismiss = false positive (restore the file)
		action: { type: 'string', enum: ['confirm', 'dismiss'] },
	},
	required: ['id', 'action'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverMeta: MiMeta,

		@Inject(DI.csamQuarantineRepository)
		private csamQuarantineRepository: CsamQuarantineRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private userSuspendService: UserSuspendService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const record = await this.csamQuarantineRepository.findOneBy({ id: ps.id });
			if (record == null) throw new Error('no such record');

			if (ps.action === 'dismiss') {
				// False positive: restore the file and mark dismissed.
				if (record.fileId) {
					await this.driveFilesRepository.update(record.fileId, { isQuarantined: false });
				}
				await this.csamQuarantineRepository.update(record.id, { status: 'dismissed' });
				return;
			}

			// Confirm: keep the file de-served (evidence preservation); optionally suspend the uploader.
			await this.csamQuarantineRepository.update(record.id, { status: 'confirmed' });

			if (this.serverMeta.csamAutoSuspendOnConfirm && record.userId) {
				const user = await this.usersRepository.findOneBy({ id: record.userId });
				if (user && !user.isSuspended) {
					await this.userSuspendService.suspend(user, me);
				}
			}
		});
	}
}
