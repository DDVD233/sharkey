/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Merge reaction buckets that differ only by the U+FE0F variation selector.
 *
 * Reactions are stored normalized (FE0F stripped by ReactionService.normalize), but
 * historical / non-conforming data left both the fully-qualified and bare forms of the
 * same emoji as separate keys (e.g. "❤️" U+2764 U+FE0F vs "❤" U+2764), so they showed up
 * as two reaction buttons. This collapses the FE0F form into the bare form, summing
 * counts. ZWJ sequences (which legitimately keep FE0F) and custom emoji (":name:") are
 * left untouched.
 */
export class MergeFe0fReactions1790100000000 {
	name = 'MergeFe0fReactions1790100000000'

	async up(queryRunner) {
		// These statements full-scan the (potentially huge) note / note_reaction tables,
		// which can exceed a configured statement_timeout. Lift it for this migration's
		// transaction only (SET LOCAL reverts on commit/rollback).
		await queryRunner.query(`SET LOCAL statement_timeout = 0`);

		// 1. Aggregate counts in note.reactions, merging FE0F-stripped keys.
		await queryRunner.query(`
			UPDATE "note" AS n
			SET "reactions" = sub.merged
			FROM (
				SELECT id, jsonb_object_agg(canon, cnt) AS merged
				FROM (
					SELECT n2.id AS id,
						CASE
							WHEN e.key LIKE '%' || E'\\u200D' || '%' THEN e.key
							WHEN e.key LIKE ':%' THEN e.key
							ELSE replace(e.key, E'\\uFE0F', '')
						END AS canon,
						sum((e.value #>> '{}')::int) AS cnt
					FROM "note" n2
					CROSS JOIN LATERAL jsonb_each(n2."reactions") AS e(key, value)
					WHERE n2."reactions"::text LIKE '%' || E'\\uFE0F' || '%'
					GROUP BY n2.id, canon
				) t
				GROUP BY id
			) sub
			WHERE n.id = sub.id
		`);

		// 2. Strip FE0F from the per-user reaction rows so myReaction matches the merged
		// bucket. Safe against the (userId, noteId) unique index: the key is unchanged.
		await queryRunner.query(`
			UPDATE "note_reaction"
			SET "reaction" = replace("reaction", E'\\uFE0F', '')
			WHERE "reaction" LIKE '%' || E'\\uFE0F' || '%'
				AND "reaction" NOT LIKE ':%'
				AND "reaction" NOT LIKE '%' || E'\\u200D' || '%'
		`);
	}

	async down(queryRunner) {
		// Irreversible: the FE0F / bare split cannot be reconstructed once merged.
	}
}
