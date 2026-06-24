/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extends note_recommendation_impression into a complete feature store for the learned heavy ranker:
 * snapshots the remaining raw rank-time signals (popularity, the structural penalties, topic interest,
 * cf-hit), the learned-ranker score, and the client-reported dwell time. All nullable so existing rows
 * and fallback-tail notes (served without a breakdown) stay valid.
 */
export class ImpressionRankerFeatures1790500000000 {
	name = 'ImpressionRankerFeatures1790500000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "popularityScore" real`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."popularityScore" IS 'Soft-normalized engagement/popularity ∈ [0,1] at serve time.'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "shortnessSignal" real`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."shortnessSignal" IS 'Short-post penalty signal ∈ [0,1] (0 for image posts / full-length prose).'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "overTagSignal" real`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."overTagSignal" IS 'Over-tagging penalty signal ∈ [0,1].'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "isReplySignal" boolean`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."isReplySignal" IS 'Whether the note was a standalone (non-self) reply.'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "topicInterest" real`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."topicInterest" IS 'User interest in the note topic ∈ {-1,0,1}.'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "cfHit" boolean`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."cfHit" IS 'Whether a taste-neighbour engaged this note (CF candidate).'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "learnedScore" real`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."learnedScore" IS 'Learned heavy-ranker value-weighted score at serve time (null in pure hand-tuned mode).'`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" ADD COLUMN IF NOT EXISTS "dwellMs" integer`);
		await queryRunner.query(`COMMENT ON COLUMN "note_recommendation_impression"."dwellMs" IS 'Client-reported dwell time in ms (how long the note stayed on screen); "good click" training label.'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "dwellMs"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "learnedScore"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "cfHit"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "topicInterest"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "isReplySignal"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "overTagSignal"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "shortnessSignal"`);
		await queryRunner.query(`ALTER TABLE "note_recommendation_impression" DROP COLUMN IF EXISTS "popularityScore"`);
	}
}
