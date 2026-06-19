/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserInferredLang1781800000000 {
	name = 'UserInferredLang1781800000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "inferredLang" character varying(16)`);
		await queryRunner.query(`COMMENT ON COLUMN "user"."inferredLang" IS 'Language inferred from the majority of the user''s recent notes (ISO 639-1, e.g. "en"), or null if not yet computed.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "inferredLang"`);
	}
}
