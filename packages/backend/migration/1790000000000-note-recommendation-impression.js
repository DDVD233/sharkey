/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteRecommendationImpression1790000000000 {
	name = 'NoteRecommendationImpression1790000000000'

	async up(queryRunner) {
		await queryRunner.query(`
			CREATE TABLE IF NOT EXISTS "note_recommendation_impression" (
				"id" character varying(32) NOT NULL,
				"userId" character varying(32) NOT NULL,
				"noteId" character varying(32) NOT NULL,
				"pushedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
				"source" character varying(32),
				CONSTRAINT "PK_note_recommendation_impression" PRIMARY KEY ("id")
			)`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."source" IS 'Which candidate source surfaced this note: ann | perUser | global | fallback.'`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_note_rec_impression_userId" ON "note_recommendation_impression" ("userId")`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_note_rec_impression_user_note" ON "note_recommendation_impression" ("userId", "noteId")`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_note_rec_impression_pushedAt" ON "note_recommendation_impression" ("pushedAt")`);
		// No FK constraints: this is append-only analytics/training data, and adding FKs would fail on
		// impressions whose note/user was since deleted (orphans are harmless here).
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE IF EXISTS "note_recommendation_impression"`);
	}
}
