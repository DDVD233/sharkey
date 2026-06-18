/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class EnableLlmTranslation1781780000000 {
	name = 'EnableLlmTranslation1781780000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "enableLlmTranslation" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableLlmTranslation"`);
	}
}
