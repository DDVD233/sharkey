/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RecommendationSettings1790400000000 {
	name = 'RecommendationSettings1790400000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD COLUMN IF NOT EXISTS "recommendationSettings" jsonb`);
		await queryRunner.query(`COMMENT ON COLUMN "user_profile"."recommendationSettings" IS 'Per-user recommendation tuning (factor coefficients, engagement weights, NSFW toggle, interest/disinterest topics). null = all defaults.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN IF EXISTS "recommendationSettings"`);
	}
}
