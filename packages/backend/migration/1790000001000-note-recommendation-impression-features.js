/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteRecommendationImpressionFeatures1790000001000 {
	name = 'NoteRecommendationImpressionFeatures1790000001000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "rank" smallint`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "annScore" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "qualityScore" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "recencyScore" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "langWeight" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "alpha" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "score" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "followed" boolean`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "isMultimodal" boolean`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "isMultimodal"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "followed"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "score"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "alpha"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "langWeight"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "recencyScore"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "qualityScore"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "annScore"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "rank"`);
	}
}
