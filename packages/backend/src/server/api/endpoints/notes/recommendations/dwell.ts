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

	// Reports how long recommended notes stayed on screen (dwell time). Folded into the most recent
	// impression row for each note as the "good click" training signal for the learned ranker — the
	// recommendation analog of Twitter's good_click / dwell engagement. Best-effort, fire-and-forget.
	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {},
	},

	limit: {
		duration: 1000 * 60,
		max: 60,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		items: {
			type: 'array',
			maxItems: 50,
			items: {
				type: 'object',
				properties: {
					noteId: { type: 'string', format: 'misskey:id' },
					dwellMs: { type: 'integer', minimum: 0, maximum: 3600000 },
				},
				required: ['noteId', 'dwellMs'],
			},
		},
	},
	required: ['items'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.recommendationService.recordDwell(me.id, ps.items);
			return {};
		});
	}
}
