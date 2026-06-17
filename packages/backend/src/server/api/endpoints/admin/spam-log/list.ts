/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { SpamLogsRepository, NotesRepository, UsersRepository, DriveFilesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:abuse-user-reports',
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
		page: { type: 'integer', minimum: 0, default: 0 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.spamLogsRepository)
		private spamLogsRepository: SpamLogsRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,
	) {
		super(meta, paramDef, async (ps) => {
			// Only note strikes (skip profile strikes for now).
			const [logs, count] = await this.spamLogsRepository.createQueryBuilder('s')
				.where('s.noteId IS NOT NULL')
				.orderBy('s.createdAt', 'DESC')
				.skip(ps.page * ps.limit)
				.take(ps.limit)
				.getManyAndCount();

			const noteIds = logs.map(l => l.noteId).filter((x): x is string => x != null);
			const userIds = [...new Set(logs.map(l => l.userId))];

			const notes = noteIds.length > 0 ? await this.notesRepository.findBy({ id: In(noteIds) }) : [];
			const users = userIds.length > 0 ? await this.usersRepository.findBy({ id: In(userIds) }) : [];
			const noteMap = new Map(notes.map(n => [n.id, n]));
			const userMap = new Map(users.map(u => [u.id, u]));

			// Resolve image URLs so moderators can review hidden posts inline (the live note page
			// denies access because the post is author-only once hidden).
			const allFileIds = [...new Set(notes.flatMap(n => n.fileIds))];
			const files = allFileIds.length > 0 ? await this.driveFilesRepository.findBy({ id: In(allFileIds) }) : [];
			const fileUrlMap = new Map(files.filter(f => f.type.startsWith('image/')).map(f => [f.id, f.thumbnailUrl ?? f.webpublicUrl ?? f.url]));

			return {
				count,
				items: logs.map(l => {
					const note = l.noteId ? noteMap.get(l.noteId) : undefined;
					const user = userMap.get(l.userId);
					return {
						id: l.id,
						createdAt: l.createdAt.toISOString(),
						label: l.label,
						score: l.score,
						reason: l.reason,
						noteId: l.noteId,
						noteExists: note != null,
						visibility: note?.visibility ?? null,
						text: note?.text ?? null,
						cw: note?.cw ?? null,
						files: (note?.fileIds ?? []).map(fid => fileUrlMap.get(fid)).filter((u): u is string => u != null),
						userId: l.userId,
						username: user?.username ?? null,
						userHost: l.userHost,
						userName: user?.name ?? null,
					};
				}),
			};
		});
	}
}
