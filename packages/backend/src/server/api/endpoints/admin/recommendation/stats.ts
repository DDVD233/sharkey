/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { NoteRecommendationImpressionsRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:show-user',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			totalRecommended: { type: 'integer', optional: false, nullable: false },
			totalUsers: { type: 'integer', optional: false, nullable: false },
			daily: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						date: { type: 'string', optional: false, nullable: false },
						recommended: { type: 'integer', optional: false, nullable: false },
						activeUsers: { type: 'integer', optional: false, nullable: false },
						reactionRate: { type: 'number', optional: false, nullable: false },
					},
				},
			},
			users: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						userId: { type: 'string', optional: false, nullable: false },
						username: { type: 'string', optional: false, nullable: false },
						viewed: { type: 'integer', optional: false, nullable: false },
						recentViewed: { type: 'integer', optional: false, nullable: false },
						likeRate: { type: 'number', optional: false, nullable: false },
						recentLikeRate: { type: 'number', optional: false, nullable: false },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.noteRecommendationImpressionsRepository)
		private noteRecommendationImpressionsRepository: NoteRecommendationImpressionsRepository,
	) {
		super(meta, paramDef, async (ps) => {
			const db = this.noteRecommendationImpressionsRepository.manager;
			const days = ps.days; // validated integer, safe to inline into the interval

			// Totals.
			const [totals] = await db.query(
				'SELECT count(*)::int AS total, count(DISTINCT "userId")::int AS users FROM note_recommendation_impression',
			) as { total: number; users: number }[];

			// Per-day: posts recommended, distinct active users, and the reaction rate (share of
			// recommended posts the recipient reacted to — note_reaction has a unique (userId, noteId)
			// index so the join is an index lookup per impression).
			const dailyRows = await db.query(
				`SELECT to_char(date_trunc('day', i."pushedAt"), 'YYYY-MM-DD') AS date,
					count(*)::int AS recommended,
					count(DISTINCT i."userId")::int AS active_users,
					count(*) FILTER (WHERE r.id IS NOT NULL)::int AS reacted
				FROM note_recommendation_impression i
				LEFT JOIN note_reaction r ON r."userId" = i."userId" AND r."noteId" = i."noteId"
				WHERE i."pushedAt" > now() - interval '${days} days'
				GROUP BY 1 ORDER BY 1`,
			) as { date: string; recommended: number; active_users: number; reacted: number }[];

			// Per-user: cumulative viewed/reacted, plus the reaction rate on the most recent day used.
			const userRows = await db.query(
				`WITH per_user AS (
					SELECT i."userId" AS uid,
						count(*)::int AS viewed,
						count(*) FILTER (WHERE r.id IS NOT NULL)::int AS reacted,
						max(date_trunc('day', i."pushedAt")) AS last_day
					FROM note_recommendation_impression i
					LEFT JOIN note_reaction r ON r."userId" = i."userId" AND r."noteId" = i."noteId"
					GROUP BY i."userId"
				),
				recent AS (
					SELECT i."userId" AS uid,
						count(*)::int AS dviewed,
						count(*) FILTER (WHERE r.id IS NOT NULL)::int AS dreacted
					FROM note_recommendation_impression i
					JOIN per_user p ON p.uid = i."userId" AND date_trunc('day', i."pushedAt") = p.last_day
					LEFT JOIN note_reaction r ON r."userId" = i."userId" AND r."noteId" = i."noteId"
					GROUP BY i."userId"
				)
				SELECT p.uid AS "userId", u.username AS username,
					p.viewed AS viewed, p.reacted AS reacted,
					COALESCE(rec.dviewed, 0)::int AS dviewed, COALESCE(rec.dreacted, 0)::int AS dreacted
				FROM per_user p
				JOIN "user" u ON u.id = p.uid
				LEFT JOIN recent rec ON rec.uid = p.uid
				ORDER BY p.viewed DESC
				LIMIT 1000`,
			) as { userId: string; username: string; viewed: number; reacted: number; dviewed: number; dreacted: number }[];

			const rate = (num: number, den: number) => (den > 0 ? num / den : 0);

			return {
				totalRecommended: totals?.total ?? 0,
				totalUsers: totals?.users ?? 0,
				daily: dailyRows.map(d => ({
					date: d.date,
					recommended: d.recommended,
					activeUsers: d.active_users,
					reactionRate: rate(d.reacted, d.recommended),
				})),
				users: userRows.map(u => ({
					userId: u.userId,
					username: u.username,
					viewed: u.viewed,
					recentViewed: u.dviewed,
					likeRate: rate(u.reacted, u.viewed),
					recentLikeRate: rate(u.dreacted, u.dviewed),
				})),
			};
		});
	}
}
