/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RecommendationService } from '@/core/RecommendationService.js';

export const meta = {
	tags: ['account'],

	requireCredential: true,

	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			interested: {
				type: 'array',
				optional: false, nullable: false,
				items: { type: 'string', optional: false, nullable: false },
			},
			disinterested: {
				type: 'array',
				optional: false, nullable: false,
				items: { type: 'string', optional: false, nullable: false },
			},
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
		super(meta, paramDef, async (ps, me) => {
			// The user's effective topic interest (auto-derived from engagement + their explicit picks),
			// so the recommendations settings page can pre-fill the interested/not-interested lists.
			return this.recommendationService.getUserTopicInterest(me.id);
		});
	}
}
