/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { RecommendationService } from '@/core/RecommendationService.js';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	// Burst to cover the initial tab load, then a steadier drip for infinite scroll / refresh.
	limit: {
		type: 'bucket',
		size: 15,
		dripSize: 4,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
		// The feed is a server-maintained queue (no id cursor): `offset` advances the anonymous/fallback
		// path and signals "fresh open" vs "load more" for logged-in users; `refresh` forces a re-rank.
		offset: { type: 'integer', minimum: 0, default: 0 },
		refresh: { type: 'boolean', default: false },
		// The client's current UI locale; recommendations are restricted to this language (zh-CN/zh-TW → zh).
		lang: { type: 'string', nullable: true },
		// Whether the user shows sensitive/NSFW content by default. When false (the default), sensitive
		// notes are softly down-ranked since they're hidden anyway and reduce feed quality.
		withSensitive: { type: 'boolean', default: false },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private noteEntityService: NoteEntityService,
		private recommendationService: RecommendationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const langs = await this.recommendationService.resolveLangs(me ? me.id : null, ps.lang);
			const notes = await this.recommendationService.getPage(me ? me.id : null, langs, ps.limit, ps.refresh, ps.offset, !ps.withSensitive);
			return await this.noteEntityService.packMany(notes, me);
		});
	}
}
