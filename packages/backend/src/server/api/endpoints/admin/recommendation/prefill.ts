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
		days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
		limit: { type: 'integer', minimum: 1, maximum: 5000000, default: 2000000 },
		// Languages to embed; omit to use the configured supportedLangs. e.g. ["zh"].
		langs: { type: 'array', items: { type: 'string' }, nullable: true },
		// Only (re)embed notes that have image attachments — e.g. to upgrade them to multimodal vectors.
		imagesOnly: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps) => {
			// Fire-and-forget: enqueuing a large window can take a while, so we don't block the request.
			// Progress and the final count are written to the server log ('recommendation' sub-logger).
			this.recommendationService.prefillRecent(ps.days, ps.limit, ps.langs ?? undefined, ps.imagesOnly)
				.catch(() => { /* logged inside */ });
			return { started: true };
		});
	}
}
