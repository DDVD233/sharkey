/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class SpamAndCsamFilter1781740000000 {
	name = 'SpamAndCsamFilter1781740000000'

	async up(queryRunner) {
		// #region meta: spam filter
		await queryRunner.query(`ALTER TABLE "meta" ADD "enableSpamFilter" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterServerUrl" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterApiKey" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterModel" character varying(256) NOT NULL DEFAULT 'Qwen/Qwen2.5-VL-7B-Instruct'`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterThresholdSpam" double precision NOT NULL DEFAULT 0.85`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterThresholdAd" double precision NOT NULL DEFAULT 0.85`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterThresholdPhishing" double precision NOT NULL DEFAULT 0.8`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamAccountMaxAgeDays" integer NOT NULL DEFAULT 365`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamWindowDays" integer NOT NULL DEFAULT 30`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamCountThreshold" integer NOT NULL DEFAULT 5`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterModeratorUserId" character varying(32)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamMaxImagesPerNote" integer NOT NULL DEFAULT 4`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamRequestTimeoutMs" integer NOT NULL DEFAULT 15000`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "spamFilterSkipHosts" character varying array NOT NULL DEFAULT '{}'`);
		// #endregion

		// #region meta: csam filter + digest email
		await queryRunner.query(`ALTER TABLE "meta" ADD "enableCsamFilter" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "csamAutoSuspendOnConfirm" boolean NOT NULL DEFAULT true`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "moderationReportEmail" character varying(1024)`);
		await queryRunner.query(`ALTER TABLE "meta" ADD "moderationReportEmailSkipIfEmpty" boolean NOT NULL DEFAULT true`);
		// #endregion

		// #region drive_file quarantine flag
		await queryRunner.query(`ALTER TABLE "drive_file" ADD "isQuarantined" boolean NOT NULL DEFAULT false`);
		// #endregion

		// #region spam_log
		await queryRunner.query(`CREATE TYPE "public"."spam_log_label_enum" AS ENUM('spam', 'ad', 'phishing', 'ham')`);
		await queryRunner.query(`CREATE TABLE "spam_log" (
			"id" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"noteId" character varying(32) NOT NULL,
			"userId" character varying(32) NOT NULL,
			"userHost" character varying(512),
			"label" "public"."spam_log_label_enum" NOT NULL,
			"score" double precision NOT NULL,
			"reason" character varying(1024),
			CONSTRAINT "PK_spam_log" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_spam_log_createdAt" ON "spam_log" ("createdAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_spam_log_noteId" ON "spam_log" ("noteId")`);
		await queryRunner.query(`CREATE INDEX "IDX_spam_log_userId" ON "spam_log" ("userId")`);
		await queryRunner.query(`CREATE INDEX "IDX_spam_log_userHost" ON "spam_log" ("userHost")`);
		await queryRunner.query(`CREATE INDEX "IDX_spam_log_userId_createdAt" ON "spam_log" ("userId", "createdAt")`);
		await queryRunner.query(`ALTER TABLE "spam_log" ADD CONSTRAINT "FK_spam_log_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
		// #endregion

		// #region csam_denylist
		await queryRunner.query(`CREATE TYPE "public"."csam_denylist_hashtype_enum" AS ENUM('md5', 'pdq')`);
		await queryRunner.query(`CREATE TABLE "csam_denylist" (
			"id" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"hashType" "public"."csam_denylist_hashtype_enum" NOT NULL,
			"hashValue" character varying(1024) NOT NULL,
			"memo" character varying(1024),
			CONSTRAINT "PK_csam_denylist" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_csam_denylist_hashValue" ON "csam_denylist" ("hashValue")`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_csam_denylist_hashType_hashValue" ON "csam_denylist" ("hashType", "hashValue")`);
		// #endregion

		// #region csam_quarantine
		await queryRunner.query(`CREATE TYPE "public"."csam_quarantine_source_enum" AS ENUM('denylist', 'cloudflare', 'manual')`);
		await queryRunner.query(`CREATE TYPE "public"."csam_quarantine_status_enum" AS ENUM('pending', 'confirmed', 'dismissed')`);
		await queryRunner.query(`CREATE TABLE "csam_quarantine" (
			"id" character varying(32) NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL,
			"fileId" character varying(32),
			"userId" character varying(32),
			"userHost" character varying(512),
			"noteId" character varying(32),
			"md5" character varying(128) NOT NULL,
			"source" "public"."csam_quarantine_source_enum" NOT NULL,
			"status" "public"."csam_quarantine_status_enum" NOT NULL DEFAULT 'pending',
			"reason" character varying(1024),
			CONSTRAINT "PK_csam_quarantine" PRIMARY KEY ("id")
		)`);
		await queryRunner.query(`CREATE INDEX "IDX_csam_quarantine_createdAt" ON "csam_quarantine" ("createdAt")`);
		await queryRunner.query(`CREATE INDEX "IDX_csam_quarantine_fileId" ON "csam_quarantine" ("fileId")`);
		await queryRunner.query(`CREATE INDEX "IDX_csam_quarantine_userId" ON "csam_quarantine" ("userId")`);
		await queryRunner.query(`ALTER TABLE "csam_quarantine" ADD CONSTRAINT "FK_csam_quarantine_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
		// #endregion
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "csam_quarantine" DROP CONSTRAINT "FK_csam_quarantine_userId"`);
		await queryRunner.query(`DROP TABLE "csam_quarantine"`);
		await queryRunner.query(`DROP TYPE "public"."csam_quarantine_status_enum"`);
		await queryRunner.query(`DROP TYPE "public"."csam_quarantine_source_enum"`);

		await queryRunner.query(`DROP INDEX "public"."IDX_csam_denylist_hashType_hashValue"`);
		await queryRunner.query(`DROP INDEX "public"."IDX_csam_denylist_hashValue"`);
		await queryRunner.query(`DROP TABLE "csam_denylist"`);
		await queryRunner.query(`DROP TYPE "public"."csam_denylist_hashtype_enum"`);

		await queryRunner.query(`ALTER TABLE "spam_log" DROP CONSTRAINT "FK_spam_log_userId"`);
		await queryRunner.query(`DROP TABLE "spam_log"`);
		await queryRunner.query(`DROP TYPE "public"."spam_log_label_enum"`);

		await queryRunner.query(`ALTER TABLE "drive_file" DROP COLUMN "isQuarantined"`);

		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "moderationReportEmailSkipIfEmpty"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "moderationReportEmail"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "csamAutoSuspendOnConfirm"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableCsamFilter"`);

		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamRequestTimeoutMs"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamMaxImagesPerNote"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterModeratorUserId"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamCountThreshold"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamWindowDays"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamAccountMaxAgeDays"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterThresholdPhishing"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterThresholdAd"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterThresholdSpam"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterModel"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterApiKey"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "spamFilterServerUrl"`);
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableSpamFilter"`);
	}
}
