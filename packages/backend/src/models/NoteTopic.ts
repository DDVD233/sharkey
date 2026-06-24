/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';

/**
 * The single topic (from the fixed taxonomy in `core/rec-topics.ts`) assigned to a note by the LLM
 * classifier. Computed once in the score queue and persisted here so it's never re-classified; per-user
 * topic interest is derived from the topics of the notes a user engages with. One row per note.
 */
@Entity('note_topic')
export class MiNoteTopic {
	@PrimaryColumn(id())
	public noteId: MiNote['id'];

	@ManyToOne(type => MiNote, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public note: MiNote | null;

	@Index()
	@Column('varchar', {
		length: 32,
		comment: 'Assigned topic (canonical label from the fixed taxonomy).',
	})
	public topic: string;

	@Column('timestamp with time zone', {
		default: () => 'now()',
	})
	public assignedAt: Date;
}
