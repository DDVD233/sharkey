/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteRecommendationImpressionAuthorCf1790200000000 {
	name = 'NoteRecommendationImpressionAuthorCf1790200000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "authorScore" real`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "cfScore" real`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "cfScore"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "authorScore"`);
	}
}
