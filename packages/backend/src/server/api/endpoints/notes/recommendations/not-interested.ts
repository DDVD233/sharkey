/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RecommendationService } from '@/core/RecommendationService.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,

	kind: 'write:account',

	// Records an explicit "not interested" on a recommended note: pushes the user's interest vector away
	// from it, stores it as a strong-negative training label, and excludes it from future recommendations.
	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {},
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
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.recommendationService.markNotInterested(me.id, ps.noteId);
			return {};
		});
	}
}
