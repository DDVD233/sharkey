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
		comment: 'Which candidate source surfaced this note: ann | following | cf | social | perUser | global | fallback.',
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

	@Column('real', { nullable: true, comment: 'User↔author-centroid cosine ∈ [0,1] (author-similarity prior); = annScore when no centroid.' })
	public authorScore: number | null;

	@Column('real', { nullable: true, comment: 'Collaborative-filtering retrieval score (taste-neighbour weighted); 0 if not CF-sourced.' })
	public cfScore: number | null;

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

	// --- extended feature snapshot (the full heavy-ranker feature vector + outcomes) ------------------

	@Column('real', { nullable: true, comment: 'Soft-normalized engagement/popularity ∈ [0,1] at serve time.' })
	public popularityScore: number | null;

	@Column('real', { nullable: true, comment: 'Short-post penalty signal ∈ [0,1] (0 for image posts / full-length prose).' })
	public shortnessSignal: number | null;

	@Column('real', { nullable: true, comment: 'Over-tagging penalty signal ∈ [0,1].' })
	public overTagSignal: number | null;

	@Column('boolean', { nullable: true, comment: 'Whether the note was a standalone (non-self) reply.' })
	public isReplySignal: boolean | null;

	@Column('real', { nullable: true, comment: 'User interest in the note topic ∈ {-1,0,1}.' })
	public topicInterest: number | null;

	@Column('boolean', { nullable: true, comment: 'Whether a taste-neighbour engaged this note (CF candidate).' })
	public cfHit: boolean | null;

	@Column('real', { nullable: true, comment: 'Learned heavy-ranker value-weighted score at serve time (null in pure hand-tuned mode).' })
	public learnedScore: number | null;

	@Column('integer', { nullable: true, comment: 'Client-reported dwell time in ms (how long the note stayed on screen); "good click" training label.' })
	public dwellMs: number | null;
}
