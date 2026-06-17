/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

export const csamQuarantineSources = ['denylist', 'cloudflare', 'manual'] as const;
export type CsamQuarantineSource = typeof csamQuarantineSources[number];

export const csamQuarantineStatuses = ['pending', 'confirmed', 'dismissed'] as const;
export type CsamQuarantineStatus = typeof csamQuarantineStatuses[number];

/**
 * Evidence/holding record for a drive file the CSAM filter quarantined.
 * The underlying file is de-served (not deleted) until a moderator resolves the record,
 * to preserve evidence for the legally-required report.
 */
@Entity('csam_quarantine')
export class MiCsamQuarantine {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column('timestamp with time zone')
	public createdAt: Date;

	/** The quarantined drive file (kept as a plain id; the file row may later be deleted). */
	@Index()
	@Column({
		...id(),
		nullable: true,
	})
	public fileId: string | null;

	@Index()
	@Column({
		...id(),
		nullable: true,
	})
	public userId: MiUser['id'] | null;

	@ManyToOne(type => MiUser, {
		onDelete: 'SET NULL',
		nullable: true,
	})
	@JoinColumn()
	public user: MiUser | null;

	/** Null for local uploaders, otherwise the remote host. */
	@Column('varchar', {
		length: 512, nullable: true,
	})
	public userHost: string | null;

	/** A note the file was attached to, if known. */
	@Column({
		...id(),
		nullable: true,
	})
	public noteId: string | null;

	@Column('varchar', {
		length: 128,
	})
	public md5: string;

	@Column('enum', {
		enum: csamQuarantineSources,
	})
	public source: CsamQuarantineSource;

	@Column('enum', {
		enum: csamQuarantineStatuses,
		default: 'pending',
	})
	public status: CsamQuarantineStatus;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public reason: string | null;
}
