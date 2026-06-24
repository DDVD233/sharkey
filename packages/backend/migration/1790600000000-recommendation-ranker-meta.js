/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Admin-global config for the learned ("heavy") recommendation ranker:
 *  - recommendationRankerModel  : the trained per-engagement logistic heads (JSON), written by the
 *                                 offline learner. Null until first trained → serving uses the legacy
 *                                 hand-tuned additive score.
 *  - recommendationRankerWeight : blend λ ∈ [0,1] ramping hand-tuned (0) → learned (1) via rank fusion.
 *                                 Defaults to 0 so deploying a model is a no-op until deliberately ramped.
 *  - recommendationEngagementValues : Twitter-style product value weights per engagement outcome (JSON);
 *                                 empty → the in-source defaults.
 */
export class RecommendationRankerMeta1790600000000 {
	name = 'RecommendationRankerMeta1790600000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "recommendationRankerModel" jsonb`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."recommendationRankerModel" IS 'Trained learned-ranker model (per-engagement logistic heads), written by the offline learner; null = use the hand-tuned score.'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "recommendationRankerWeight" double precision NOT NULL DEFAULT 0`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."recommendationRankerWeight" IS 'Blend λ ∈ [0,1] ramping the hand-tuned score (0) toward the learned ranker (1) via rank fusion.'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "recommendationEngagementValues" jsonb NOT NULL DEFAULT '{}'`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."recommendationEngagementValues" IS 'Per-engagement product value weights for the learned ranker (reply ≫ like, dislike strongly negative); empty = in-source defaults.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN IF EXISTS "recommendationEngagementValues"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN IF EXISTS "recommendationRankerWeight"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN IF EXISTS "recommendationRankerModel"`);
	}
}
