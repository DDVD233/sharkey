/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { CsamQuarantineRepository } from '@/models/_.js';
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
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		status: { type: 'string', enum: ['pending', 'confirmed', 'dismissed'] },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.csamQuarantineRepository)
		private csamQuarantineRepository: CsamQuarantineRepository,
	) {
		super(meta, paramDef, async (ps) => {
			const query = this.csamQuarantineRepository.createQueryBuilder('q');
			if (ps.sinceId) query.andWhere('q.id > :sinceId', { sinceId: ps.sinceId });
			if (ps.untilId) query.andWhere('q.id < :untilId', { untilId: ps.untilId });
			if (ps.status) query.andWhere('q.status = :status', { status: ps.status });
			const items = await query.orderBy('q.id', 'DESC').limit(ps.limit).getMany();
			return items.map(i => ({
				id: i.id,
				createdAt: i.createdAt.toISOString(),
				fileId: i.fileId,
				userId: i.userId,
				userHost: i.userHost,
				noteId: i.noteId,
				md5: i.md5,
				source: i.source,
				status: i.status,
				reason: i.reason,
			}));
		});
	}
}
