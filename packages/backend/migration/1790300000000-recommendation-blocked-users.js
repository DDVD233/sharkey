/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RecommendationBlockedUsers1790300000000 {
	name = 'RecommendationBlockedUsers1790300000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "recommendationBlockedUsers" character varying(1024) array NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."recommendationBlockedUsers" IS 'Acct handles (e.g. @alice, @bob@host) of users excluded entirely from the recommendation system: their notes are never embedded, quality-scored, indexed, or surfaced in any recommendation feed.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN IF EXISTS "recommendationBlockedUsers"`);
	}
}
