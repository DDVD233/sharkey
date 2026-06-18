/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class LlmTranslate1781760000000 {
	name = 'LlmTranslate1781760000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "llmTranslateURL" character varying(1024)`);
		await queryRunner.query(`COMMENT ON COLUMN "meta"."llmTranslateURL" IS 'Base URL of an OpenAI-compatible (e.g. vLLM) endpoint used for LLM translation. When set, it is used as the only translation service.'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "llmTranslateKey" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "llmTranslateModel" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "llmTranslatePrompt" character varying(8192)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "llmTranslatePrompt"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "llmTranslateModel"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "llmTranslateKey"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "llmTranslateURL"`);
	}
}
