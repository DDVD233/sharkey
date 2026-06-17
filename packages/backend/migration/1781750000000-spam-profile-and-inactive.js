/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class SpamProfileAndInactive1781750000000 {
	name = 'SpamProfileAndInactive1781750000000'

	async up(queryRunner) {
		// profile-spam strikes have no note
		await queryRunner.query(`ALTER TABLE "spam_log" ALTER COLUMN "noteId" DROP NOT NULL`);
		// also scan old-but-dormant accounts
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamInactiveDays" integer NOT NULL DEFAULT 90`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamInactiveDays"`);
		await queryRunner.query(`ALTER TABLE "spam_log" ALTER COLUMN "noteId" SET NOT NULL`);
	}
}
