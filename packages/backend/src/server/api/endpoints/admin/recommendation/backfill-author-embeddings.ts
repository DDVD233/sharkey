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
			started: { type: 'boolean', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		// How far back to collect authors of public notes (their centroid is computed from their whole
		// available note history regardless; this just bounds the author set to recently-active ones).
		sinceDays: { type: 'integer', minimum: 1, maximum: 365, default: 70 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps) => {
			// Fire-and-forget: backfilling all authors takes a while; progress + the final count go to the
			// 'recommendation' sub-logger.
			this.recommendationService.backfillAuthorCentroids(ps.sinceDays)
				.catch(() => { /* logged inside */ });
			return { started: true };
		});
	}
}
