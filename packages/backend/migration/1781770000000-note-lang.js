/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteLang1781770000000 {
	name = 'NoteLang1781770000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" ADD COLUMN IF NOT EXISTS "lang" character varying(16)`);
		await queryRunner.query(`COMMENT ON COLUMN "note"."lang" IS 'Detected language of the note text (ISO 639-1, e.g. "en"), or null if unknown/undetected.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "lang"`);
	}
}
