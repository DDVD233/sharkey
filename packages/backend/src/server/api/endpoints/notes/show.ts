/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { DI } from '@/di-symbols.js';
import type { NotesRepository } from '@/models/_.js';
import { QueryService } from '@/core/QueryService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'Note',
	},

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: '24fcbfc6-2e37-42b6-8388-c29b3861a08d',
		},

		followersOnly: {
			message: 'This note is only visible to the author\'s followers.',
			code: 'FOLLOWERS_ONLY',
			id: '889fca7e-d028-47a8-8c17-e2960ac10996',
			kind: 'permission',
			httpStatusCode: 403,
		},

		signinRequired: {
			message: 'Signin required.',
			code: 'SIGNIN_REQUIRED',
			id: '8e75455b-738c-471d-9f80-62693f33372e',
		},
	},

	// 2 calls per second
	limit: {
		duration: 1000,
		max: 2,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private noteEntityService: NoteEntityService,
		private queryService: QueryService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = await this.notesRepository.createQueryBuilder('note')
				.where('note.id = :noteId', { noteId: ps.noteId })
				.innerJoinAndSelect('note.user', 'user');

			this.queryService.generateVisibilityQuery(query, me);
			if (me) {
				this.queryService.generateBlockedUserQueryForNotes(query, me);
			}

			const note = await query.getOne();

			if (note === null) {
				// The note may exist but be hidden from the viewer. Re-check existence
				// honoring blocks (so blocked notes stay indistinguishable from deleted
				// ones) but ignoring visibility, so we can return a clearer error for
				// followers-only notes the viewer isn't allowed to see (e.g. a boost
				// federated as followers-only).
				const hiddenQuery = this.notesRepository.createQueryBuilder('note')
					.where('note.id = :noteId', { noteId: ps.noteId });
				if (me) {
					this.queryService.generateBlockedUserQueryForNotes(hiddenQuery, me);
				}
				const hiddenNote = await hiddenQuery.getOne();

				if (hiddenNote !== null && hiddenNote.visibility === 'followers') {
					throw new ApiError(meta.errors.followersOnly);
				}

				throw new ApiError(meta.errors.noSuchNote);
			}

			if (note.user!.requireSigninToViewContents && me == null) {
				throw new ApiError(meta.errors.signinRequired);
			}

			return await this.noteEntityService.pack(note, me, {
				detail: true,
			});
		});
	}
}
