/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RecommendationService } from '@/core/RecommendationService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:queue',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			users: { type: 'number', optional: false, nullable: false },
			notesScanned: { type: 'number', optional: false, nullable: false },
			hqRemoved: { type: 'number', optional: false, nullable: false },
			featRemoved: { type: 'number', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async () => {
			// Synchronous: scans only the blocklisted users' own notes (bounded for a small blocklist), so
			// the admin gets a removal summary back rather than a fire-and-forget. Removes pre-existing
			// vectors / centroids / high-quality-index entries / feature cache for currently-blocked users.
			return await this.recommendationService.purgeBlockedUsers();
		});
	}
}
