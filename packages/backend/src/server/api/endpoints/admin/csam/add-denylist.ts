/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { CsamDenylistRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:resolve-abuse-user-report',

	res: {
		type: 'object',
		properties: {
			id: { type: 'string' },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		hashType: { type: 'string', enum: ['md5', 'pdq'], default: 'md5' },
		hashValue: { type: 'string', minLength: 1 },
		memo: { type: 'string', nullable: true },
	},
	required: ['hashValue'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.csamDenylistRepository)
		private csamDenylistRepository: CsamDenylistRepository,

		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const id = this.idService.gen();
			await this.csamDenylistRepository.insert({
				id,
				createdAt: new Date(),
				hashType: ps.hashType,
				hashValue: ps.hashValue.trim().toLowerCase(),
				memo: ps.memo ?? null,
			});

			return { id };
		});
	}
}
