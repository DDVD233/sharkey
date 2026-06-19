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
		comment: 'Which candidate source surfaced this note: ann | perUser | global | following | fallback.',
	})
	public source: string | null;

	// --- Serve-time feature snapshot (training data for a future learned ranker) ----------------
	// Each row records the score breakdown the note had when it was shown, so a model can later be
	// trained on (these features → did the user engage). All nullable: older rows / fallback-tail
	// notes may have no breakdown.

	@Column('smallint', { nullable: true, comment: 'Position in the served page (0-based); position-bias signal.' })
	public rank: number | null;

	@Column('real', { nullable: true, comment: 'ANN cosine similarity to the user interest vector, clamped to [0,1].' })
	public annScore: number | null;

	@Column('real', { nullable: true, comment: 'Content-quality ∈ [0,1] (LLM interestingness, else structural).' })
	public qualityScore: number | null;

	@Column('real', { nullable: true, comment: 'Recency decay ∈ [0,1] at serve time.' })
	public recencyScore: number | null;

	@Column('real', { nullable: true, comment: 'Soft language-preference weight applied to this note.' })
	public langWeight: number | null;

	@Column('real', { nullable: true, comment: 'Cold/warm gate α = n/(n+K) for the user at serve time.' })
	public alpha: number | null;

	@Column('real', { nullable: true, comment: 'Final blended score used for ordering.' })
	public score: number | null;

	@Column('boolean', { nullable: true, comment: 'Whether the note author is followed by the viewer.' })
	public followed: boolean | null;

	@Column('boolean', { nullable: true, comment: 'Whether the note is multimodal (has an image).' })
	public isMultimodal: boolean | null;
}
