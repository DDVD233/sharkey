/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';

export const csamHashTypes = ['md5', 'pdq'] as const;
export type CsamHashType = typeof csamHashTypes[number];

/**
 * Admin-controlled denylist of image hashes known to be CSAM.
 * The in-code CSAM filter matches uploaded files against these.
 * NOTE: there is no public CSAM hash list; entries here are populated by admins
 * from confirmed local material or hashes obtained via a trusted authority.
 */
@Entity('csam_denylist')
@Index(['hashType', 'hashValue'], { unique: true })
export class MiCsamDenylist {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone')
	public createdAt: Date;

	@Column('enum', {
		enum: csamHashTypes,
	})
	public hashType: CsamHashType;

	@Index()
	@Column('varchar', {
		length: 1024,
	})
	public hashValue: string;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public memo: string | null;
}
