/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class LlmQualityPrompt1790000002000 {
	name = 'LlmQualityPrompt1790000002000'

	async up(queryRunner) {
		// Admin-configured system prompt for the recommendation content-quality scorer. Kept in the DB
		// (not in source) so it is not part of the public release; quality scoring is off while empty.
		await queryRunner.query(`ALTER TABLE "meta" ADD COLUMN IF NOT EXISTS "llmQualityPrompt" character varying(8192)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN IF EXISTS "llmQualityPrompt"`);
	}
}
