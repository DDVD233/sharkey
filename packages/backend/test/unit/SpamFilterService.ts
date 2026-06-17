/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { jest } from '@jest/globals';
import { SpamFilterService } from '@/core/SpamFilterService.js';

function buildService(overrides: {
	meta?: Record<string, any>;
	note?: Record<string, any> | null;
	author?: Record<string, any> | null;
	verdict?: any;
	classifyThrows?: boolean;
	existingSpamLog?: boolean;
	windowCount?: number;
	files?: any[];
}) {
	const meta = {
		enableSpamFilter: true,
		spamFilterServerUrl: 'https://spam.example',
		spamFilterApiKey: 'secret',
		spamFilterModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
		spamFilterThresholdSpam: 0.85,
		spamFilterThresholdAd: 0.85,
		spamFilterThresholdPhishing: 0.8,
		spamAccountMaxAgeDays: 365,
		spamWindowDays: 30,
		spamCountThreshold: 5,
		spamFilterModeratorUserId: 'moderator1',
		spamMaxImagesPerNote: 4,
		spamRequestTimeoutMs: 15000,
		spamFilterSkipHosts: [],
		...overrides.meta,
	};

	const note = overrides.note === undefined ? {
		id: 'note1',
		text: 'buy followers now http://scam',
		fileIds: [] as string[],
		userId: 'user1',
		localOnly: false,
		mentionedRemoteUsers: '[]',
		renoteUserId: null,
		visibility: 'public',
	} : overrides.note;

	const author = overrides.author === undefined ? {
		id: 'user1',
		username: 'alice',
		host: null,
		isSuspended: false,
	} : overrides.author;

	const notesRepository = {
		findOneBy: jest.fn(async () => note),
		update: jest.fn(async () => undefined),
	};
	const usersRepository = {
		findOneBy: jest.fn(async ({ id }: { id: string }) => {
			if (author && id === author.id) return author;
			if (id === 'moderator1') return { id: 'moderator1', username: 'dvd', host: null };
			return null;
		}),
		findBy: jest.fn(async () => []),
	};
	const driveFilesRepository = {
		findBy: jest.fn(async () => overrides.files ?? []),
	};
	const spamLogsRepository = {
		existsBy: jest.fn(async () => overrides.existingSpamLog ?? false),
		insert: jest.fn(async () => undefined),
		countBy: jest.fn(async () => overrides.windowCount ?? 1),
	};
	const httpRequestService = {
		send: jest.fn(async () => {
			if (overrides.classifyThrows) throw new Error('boom');
			return { json: async () => overrides.verdict ?? { label: 'spam', confidence: 0.99, reason: 'scam' } };
		}),
	};
	const globalEventService = { publishNoteStream: jest.fn() };
	const apRendererService = {
		addContext: jest.fn((x: any) => x),
		renderDelete: jest.fn((x: any) => x),
		renderTombstone: jest.fn((x: any) => x),
	};
	const apDeliverManagerService = { deliverToFollowers: jest.fn(async () => undefined) };
	const relayService = { deliverToRelays: jest.fn(async () => undefined) };
	const userSuspendService = { suspend: jest.fn(async () => undefined) };
	const noteCreateService = { create: jest.fn(async () => ({ id: 'dm1' })) };
	const userEntityService = { isLocalUser: (u: any) => u != null && u.host == null };
	const idService = {
		gen: jest.fn(() => 'gen-id'),
		parse: jest.fn(() => ({ date: new Date() })),
	};
	const loggerService = { getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) };

	const service = new SpamFilterService(
		{ url: 'https://my.instance' } as any,
		meta as any,
		usersRepository as any,
		notesRepository as any,
		driveFilesRepository as any,
		spamLogsRepository as any,
		httpRequestService as any,
		globalEventService as any,
		apRendererService as any,
		apDeliverManagerService as any,
		relayService as any,
		userSuspendService as any,
		noteCreateService as any,
		userEntityService as any,
		idService as any,
		loggerService as any,
	);

	return { service, notesRepository, usersRepository, spamLogsRepository, httpRequestService, globalEventService, userSuspendService, noteCreateService, apDeliverManagerService, idService };
}

describe('SpamFilterService', () => {
	test('ham verdict → no action', async () => {
		const m = buildService({ verdict: { label: 'ham', confidence: 0.99, reason: 'fine' } });
		await m.service.checkNote('note1');
		expect(m.spamLogsRepository.insert).not.toHaveBeenCalled();
		expect(m.notesRepository.update).not.toHaveBeenCalled();
		expect(m.userSuspendService.suspend).not.toHaveBeenCalled();
	});

	test('confidence below threshold → no action', async () => {
		const m = buildService({ verdict: { label: 'spam', confidence: 0.5, reason: 'maybe' } });
		await m.service.checkNote('note1');
		expect(m.spamLogsRepository.insert).not.toHaveBeenCalled();
		expect(m.notesRepository.update).not.toHaveBeenCalled();
	});

	test('spam local → record, hide author-only, retract, DM', async () => {
		const m = buildService({ verdict: { label: 'spam', confidence: 0.97, reason: 'scam' }, windowCount: 1 });
		await m.service.checkNote('note1');
		expect(m.spamLogsRepository.insert).toHaveBeenCalled();
		expect(m.notesRepository.update).toHaveBeenCalledWith('note1', { visibility: 'specified', visibleUserIds: ['user1'] });
		expect(m.globalEventService.publishNoteStream).toHaveBeenCalledWith('note1', 'deleted', expect.anything());
		expect(m.apDeliverManagerService.deliverToFollowers).toHaveBeenCalled();
		expect(m.noteCreateService.create).toHaveBeenCalled(); // DM
		expect(m.userSuspendService.suspend).not.toHaveBeenCalled(); // window not reached
	});

	test('spam remote → hide but no DM and no AP delete', async () => {
		const m = buildService({
			author: { id: 'user1', username: 'bob', host: 'remote.example', isSuspended: false },
			verdict: { label: 'spam', confidence: 0.97, reason: 'scam' },
		});
		await m.service.checkNote('note1');
		expect(m.spamLogsRepository.insert).toHaveBeenCalled();
		expect(m.notesRepository.update).toHaveBeenCalled();
		expect(m.noteCreateService.create).not.toHaveBeenCalled(); // no DM for remote
		expect(m.apDeliverManagerService.deliverToFollowers).not.toHaveBeenCalled(); // can't sign as remote
	});

	test('window threshold reached → suspend', async () => {
		const m = buildService({ verdict: { label: 'spam', confidence: 0.97, reason: 'scam' }, windowCount: 5 });
		await m.service.checkNote('note1');
		expect(m.userSuspendService.suspend).toHaveBeenCalled();
	});

	test('already-logged note is skipped (idempotency)', async () => {
		const m = buildService({ existingSpamLog: true });
		await m.service.checkNote('note1');
		expect(m.httpRequestService.send).not.toHaveBeenCalled();
		expect(m.spamLogsRepository.insert).not.toHaveBeenCalled();
	});

	test('system account is skipped', async () => {
		const m = buildService({ author: { id: 'user1', username: 'instance.actor', host: null, isSuspended: false } });
		await m.service.checkNote('note1');
		expect(m.httpRequestService.send).not.toHaveBeenCalled();
	});

	test('account older than max age is skipped', async () => {
		const m = buildService({});
		m.idService.parse.mockReturnValue({ date: new Date(Date.now() - 400 * 86400_000) } as any);
		await m.service.checkNote('note1');
		expect(m.httpRequestService.send).not.toHaveBeenCalled();
	});

	test('empty note (no text, no images) is skipped', async () => {
		const m = buildService({ note: {
			id: 'note1', text: '', fileIds: [], userId: 'user1', localOnly: false, mentionedRemoteUsers: '[]', renoteUserId: null, visibility: 'public',
		} });
		await m.service.checkNote('note1');
		expect(m.httpRequestService.send).not.toHaveBeenCalled();
	});

	test('classifier error → fail-open (no throw, no action)', async () => {
		const m = buildService({ classifyThrows: true });
		await expect(m.service.checkNote('note1')).resolves.toBeUndefined();
		expect(m.spamLogsRepository.insert).not.toHaveBeenCalled();
		expect(m.notesRepository.update).not.toHaveBeenCalled();
	});

	test('disabled filter → no-op', async () => {
		const m = buildService({ meta: { enableSpamFilter: false } });
		await m.service.checkNote('note1');
		expect(m.notesRepository.findOneBy).not.toHaveBeenCalled();
	});
});
