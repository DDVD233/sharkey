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
		// Populate the high-quality (q≥4) discovery index from already-scored notes in this window.
		days: { type: 'integer', minimum: 1, maximum: 365, default: 14 },
		limit: { type: 'integer', minimum: 1, maximum: 5000000, default: 2000000 },
		// Languages to index; omit to use the configured supportedLangs. e.g. ["zh"].
		langs: { type: 'array', items: { type: 'string' }, nullable: true },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps) => {
			// Fire-and-forget: progress and the final count are written to the 'recommendation' sub-logger.
			this.recommendationService.backfillHighQualityIndex(ps.days, ps.limit, ps.langs ?? undefined)
				.catch(() => { /* logged inside */ });
			return { started: true };
		});
	}
}
