/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

export const spamLabels = ['spam', 'ad', 'phishing', 'ham'] as const;
export type SpamLabel = typeof spamLabels[number];

/**
 * A record of a post that the ML spam filter classified as spam/ad/phishing and acted on.
 * Doubles as the rolling-window source for auto-suspension and as a moderation audit log.
 */
@Entity('spam_log')
@Index(['userId', 'createdAt'])
export class MiSpamLog {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column('timestamp with time zone')
	public createdAt: Date;

	/** The flagged note; null for profile-spam strikes. */
	@Index()
	@Column({
		...id(),
		nullable: true,
	})
	public noteId: string | null;

	@Index()
	@Column(id())
	public userId: MiUser['id'];

	@ManyToOne(type => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	/** Null for local users, otherwise the remote host. */
	@Index()
	@Column('varchar', {
		length: 512, nullable: true,
	})
	public userHost: string | null;

	@Column('enum', {
		enum: spamLabels,
	})
	public label: SpamLabel;

	/** Model confidence in [0, 1]. */
	@Column('double precision')
	public score: number;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public reason: string | null;
}
