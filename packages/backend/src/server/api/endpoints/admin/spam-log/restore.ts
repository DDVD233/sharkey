/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { SpamLogsRepository, NotesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:resolve-abuse-user-report',

	errors: {
		noSuchEntry: {
			message: 'No such spam log entry.',
			code: 'NO_SUCH_ENTRY',
			id: 'b1c2d3e4-0000-0000-0000-000000000010',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		// spam_log entry id
		id: { type: 'string', format: 'misskey:id' },
	},
	required: ['id'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.spamLogsRepository)
		private spamLogsRepository: SpamLogsRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,
	) {
		super(meta, paramDef, async (ps) => {
			const entry = await this.spamLogsRepository.findOneBy({ id: ps.id });
			if (entry == null) throw new Error('no such entry');

			// Restore the note to public (it was set author-only when flagged).
			if (entry.noteId) {
				await this.notesRepository.update(entry.noteId, {
					visibility: 'public',
					visibleUserIds: [],
				});
			}

			// Remove from the moderated list.
			await this.spamLogsRepository.delete({ id: entry.id });
		});
	}
}
