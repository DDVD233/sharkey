/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { CsamDenylistRepository } from '@/models/_.js';
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
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.csamDenylistRepository)
		private csamDenylistRepository: CsamDenylistRepository,
	) {
		super(meta, paramDef, async (ps) => {
			const query = this.csamDenylistRepository.createQueryBuilder('item');
			if (ps.sinceId) query.andWhere('item.id > :sinceId', { sinceId: ps.sinceId });
			if (ps.untilId) query.andWhere('item.id < :untilId', { untilId: ps.untilId });
			const items = await query.orderBy('item.id', 'DESC').limit(ps.limit).getMany();
			return items.map(i => ({
				id: i.id,
				createdAt: i.createdAt.toISOString(),
				hashType: i.hashType,
				hashValue: i.hashValue,
				memo: i.memo,
			}));
		});
	}
}
