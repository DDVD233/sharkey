/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';
import { MiUser } from './User.js';

/**
 * Records which notes were pushed (shown) to which user by the recommendation feed.
 * Used as training data for future ranking models; the hot-path "don't repeat" dedup lives
 * in Redis. Rows are written best-effort and asynchronously after a page is served.
 */
@Entity('note_recommendation_impression')
@Index(['userId', 'noteId'])
export class MiNoteRecommendationImpression {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column(id())
	public userId: MiUser['id'];

	@ManyToOne(type => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	@Column(id())
	public noteId: MiNote['id'];

	@ManyToOne(type => MiNote, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public note: MiNote | null;

	@Index()
	@Column('timestamp with time zone')
	public pushedAt: Date;

	@Column('varchar', {
		length: 32, nullable: true,
		comment: 'Which candidate source surfaced this note: ann | perUser | global | fallback.',
	})
	public source: string | null;
}
