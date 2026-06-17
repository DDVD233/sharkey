/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { jest } from '@jest/globals';
import { CsamFilterService } from '@/core/CsamFilterService.js';

function buildService(overrides: {
	meta?: Record<string, any>;
	file?: Record<string, any> | null;
	denylistMatch?: any;
	existingQuarantine?: boolean;
}) {
	const meta = {
		enableCsamFilter: true,
		spamFilterModeratorUserId: 'moderator1',
		...overrides.meta,
	};

	const file = overrides.file === undefined ? {
		id: 'file1',
		md5: 'abc123',
		type: 'image/png',
		userId: 'user1',
		userHost: null,
		isQuarantined: false,
	} : overrides.file;

	const driveFilesRepository = {
		findOneBy: jest.fn(async () => file),
		update: jest.fn(async () => undefined),
	};
	const csamDenylistRepository = {
		findOneBy: jest.fn(async () => overrides.denylistMatch ?? null),
	};
	const csamQuarantineRepository = {
		existsBy: jest.fn(async () => overrides.existingQuarantine ?? false),
		insert: jest.fn(async () => undefined),
	};
	const usersRepository = { findOneBy: jest.fn(async () => null) };
	const abuseReportService = { report: jest.fn(async () => undefined) };
	const globalEventService = {};
	const idService = { gen: jest.fn(() => 'gen-id') };
	const loggerService = { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) };

	const service = new CsamFilterService(
		meta as any,
		usersRepository as any,
		driveFilesRepository as any,
		csamDenylistRepository as any,
		csamQuarantineRepository as any,
		abuseReportService as any,
		globalEventService as any,
		idService as any,
		loggerService as any,
	);

	return { service, driveFilesRepository, csamDenylistRepository, csamQuarantineRepository, abuseReportService };
}

describe('CsamFilterService', () => {
	test('MD5 denylist match → quarantine + record + abuse report', async () => {
		const m = buildService({ denylistMatch: { id: 'd1', hashType: 'md5', hashValue: 'abc123', memo: 'known' } });
		await m.service.checkFile('file1');
		expect(m.driveFilesRepository.update).toHaveBeenCalledWith('file1', { isQuarantined: true });
		expect(m.csamQuarantineRepository.insert).toHaveBeenCalled();
		expect(m.abuseReportService.report).toHaveBeenCalled();
	});

	test('no denylist match → no action', async () => {
		const m = buildService({ denylistMatch: null });
		await m.service.checkFile('file1');
		expect(m.driveFilesRepository.update).not.toHaveBeenCalled();
		expect(m.csamQuarantineRepository.insert).not.toHaveBeenCalled();
	});

	test('non-image file is skipped', async () => {
		const m = buildService({ file: { id: 'file1', md5: 'abc123', type: 'video/mp4', userId: 'user1', userHost: null, isQuarantined: false } });
		await m.service.checkFile('file1');
		expect(m.csamDenylistRepository.findOneBy).not.toHaveBeenCalled();
	});

	test('already-quarantined file is skipped', async () => {
		const m = buildService({ file: { id: 'file1', md5: 'abc123', type: 'image/png', userId: 'user1', userHost: null, isQuarantined: true } });
		await m.service.checkFile('file1');
		expect(m.csamDenylistRepository.findOneBy).not.toHaveBeenCalled();
	});

	test('existing quarantine record → skip (idempotency)', async () => {
		const m = buildService({ existingQuarantine: true, denylistMatch: { id: 'd1', hashType: 'md5', hashValue: 'abc123', memo: null } });
		await m.service.checkFile('file1');
		expect(m.csamDenylistRepository.findOneBy).not.toHaveBeenCalled();
		expect(m.csamQuarantineRepository.insert).not.toHaveBeenCalled();
	});

	test('disabled filter → no-op', async () => {
		const m = buildService({ meta: { enableCsamFilter: false } });
		await m.service.checkFile('file1');
		expect(m.driveFilesRepository.findOneBy).not.toHaveBeenCalled();
	});
});
