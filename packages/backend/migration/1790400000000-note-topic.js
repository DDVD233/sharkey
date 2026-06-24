/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteTopic1790400000000 {
	name = 'NoteTopic1790400000000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE IF NOT EXISTS "note_topic" (
			"noteId" character varying(32) NOT NULL,
			"topic" character varying(32) NOT NULL,
			"assignedAt" timestamp with time zone NOT NULL DEFAULT now(),
			CONSTRAINT "PK_note_topic" PRIMARY KEY ("noteId")
		)`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_note_topic_topic" ON "note_topic" ("topic")`);
		// FK to note so a deleted note drops its topic row (matches note_recommendation_impression).
		await queryRunner.query(`ALTER TABLE "note_topic" ADD CONSTRAINT "FK_note_topic_note"
			FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_topic" DROP CONSTRAINT IF EXISTS "FK_note_topic_note"`);
		await queryRunner.query(`DROP INDEX IF EXISTS "IDX_note_topic_topic"`);
		await queryRunner.query(`DROP TABLE IF EXISTS "note_topic"`);
	}
}
