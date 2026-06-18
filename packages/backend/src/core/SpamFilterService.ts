/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull, MoreThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiMeta, NotesRepository, UsersRepository, UserProfilesRepository, DriveFilesRepository, SpamLogsRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { SpamLabel } from '@/models/SpamLog.js';
import { spamLabels } from '@/models/SpamLog.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { InternalEventService } from '@/core/InternalEventService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { RelayService } from '@/core/RelayService.js';
import { UserSuspendService } from '@/core/UserSuspendService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { isSystemAccount } from '@/misc/is-system-account.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

const DAY_MS = 86400_000;

type SpamVerdict = {
	label: SpamLabel;
	confidence: number;
	reason: string | null;
};

@Injectable()
export class SpamFilterService implements OnApplicationShutdown {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.spamLogsRepository)
		private spamLogsRepository: SpamLogsRepository,

		private httpRequestService: HttpRequestService,
		private globalEventService: GlobalEventService,
		private internalEventService: InternalEventService,
		private queueService: QueueService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private relayService: RelayService,
		private userSuspendService: UserSuspendService,
		private noteCreateService: NoteCreateService,
		private userEntityService: UserEntityService,
		private idService: IdService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('spam-filter');
		// Scan profiles on any local/remote user update (covers bio/name/fields spam).
		this.internalEventService.on('localUserUpdated', this.onUserUpdated);
		this.internalEventService.on('remoteUserUpdated', this.onUserUpdated);
	}

	/**
	 * Whether a user is in scope for spam scanning. Remote users are always scanned (subject to
	 * the host whitelist). The age gate applies to LOCAL users only: young accounts, OR older
	 * accounts that were dormant for a while (dormant-then-active accounts are often stolen).
	 */
	@bindThis
	public isAccountInScope(user: { id: string; host: string | null; lastActiveDate: Date | null }): boolean {
		if (user.host != null) return true; // remote: scan everything
		const ageMs = Date.now() - this.idService.parse(user.id).date.getTime();
		if (ageMs < this.meta.spamAccountMaxAgeDays * DAY_MS) return true;
		if (this.meta.spamInactiveDays > 0 && user.lastActiveDate != null
			&& (Date.now() - user.lastActiveDate.getTime()) >= this.meta.spamInactiveDays * DAY_MS) return true;
		return false;
	}

	@bindThis
	private async onUserUpdated(data: { id: MiUser['id'] }): Promise<void> {
		if (!this.meta.enableSpamFilter || !this.meta.llmTranslateURL) return;
		// Throttle: scan a given user's profile at most once per hour regardless of update frequency.
		const ok = await this.redisClient.set(`spamprofilescan:${data.id}`, '1', 'EX', 3600, 'NX');
		if (ok == null) return;
		this.queueService.createSpamProfileCheckJob(data.id).catch(() => { /* ignore enqueue errors */ });
	}

	@bindThis
	public async checkNote(noteId: string): Promise<void> {
		if (!this.meta.enableSpamFilter || !this.meta.llmTranslateURL) return;

		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) return;

		// Idempotency: never act on the same note twice.
		if (await this.spamLogsRepository.existsBy({ noteId })) return;

		const author = await this.usersRepository.findOneBy({ id: note.userId });
		if (author == null) return;

		if (!this.shouldScan(author)) return;

		// Gather scannable content.
		const hasText = (note.text ?? '').trim().length > 0;
		const imageUrls = await this.collectImageUrls(note.fileIds);
		if (!hasText && imageUrls.length === 0) return;

		const verdict = await this.classifySafely(note.text ?? '', imageUrls, `note ${noteId}`);
		if (verdict == null) return;
		if (!this.isActioned(verdict)) return;

		await this.recordStrike(note.id, author, verdict);
		this.logger.info(`flagged note ${note.id} by @${author.username}${author.host ? '@' + author.host : ''} as ${verdict.label} (${verdict.confidence.toFixed(2)})`);

		await this.hidePrivate(note, author);

		if (this.userEntityService.isLocalUser(author) && this.meta.spamFilterModeratorUserId) {
			await this.notify(author, `Your recent post was automatically detected as ${verdict.label} and has been set to private, so it is no longer visible to others:\n${this.config.url}/notes/${note.id}\n\nThis was an automated moderation action. If you believe this is a mistake or have any questions, please reply to this post and a moderator will take a look.`);
		}

		await this.maybeSuspend(author);
	}

	/**
	 * Scan a user's profile (name + bio + fields) for spam. On a hit: record a strike, clear the
	 * profile, DM (local), and suspend at the rolling-window threshold.
	 */
	@bindThis
	public async checkProfile(userId: string): Promise<void> {
		if (!this.meta.enableSpamFilter || !this.meta.llmTranslateURL) return;

		const user = await this.usersRepository.findOneBy({ id: userId });
		if (user == null) return;
		if (!this.shouldScan(user)) return;

		// Dedup: at most one profile strike per user per rolling window.
		const windowStart = new Date(Date.now() - this.meta.spamWindowDays * DAY_MS);
		if (await this.spamLogsRepository.existsBy({ userId, noteId: IsNull(), createdAt: MoreThanOrEqual(windowStart) })) return;

		const profile = await this.userProfilesRepository.findOneBy({ userId });
		const parts: string[] = [];
		if (user.name) parts.push(user.name);
		if (profile?.description) parts.push(profile.description);
		for (const f of profile?.fields ?? []) {
			if (f?.name || f?.value) parts.push(`${f.name ?? ''}: ${f.value ?? ''}`);
		}
		const text = parts.join('\n').trim();
		if (text.length === 0) return;

		const verdict = await this.classifySafely(text, [], `profile ${userId}`);
		if (verdict == null) return;
		if (!this.isActioned(verdict)) return;

		await this.recordStrike(null, user, verdict);
		this.logger.info(`flagged profile of @${user.username}${user.host ? '@' + user.host : ''} as ${verdict.label} (${verdict.confidence.toFixed(2)})`);

		// Clear the (spam) profile on our instance — for remote users this clears our cached copy.
		await this.userProfilesRepository.update(userId, { description: '', fields: [] });
		await this.usersRepository.update(userId, { name: null });
		// Refresh caches; our own listener re-fire is throttled + guarded by the empty-text check above.
		this.globalEventService.publishInternalEvent(this.userEntityService.isLocalUser(user) ? 'localUserUpdated' : 'remoteUserUpdated', { id: userId });

		if (this.userEntityService.isLocalUser(user) && this.meta.spamFilterModeratorUserId) {
			await this.notify(user, 'Your profile was automatically detected as spam and has been cleared. This was an automated moderation action. If you believe this is a mistake or have any questions, please reply to this post and a moderator will take a look.');
		}

		await this.maybeSuspend(user);
	}

	@bindThis
	private shouldScan(user: MiUser): boolean {
		if (isSystemAccount(user)) return false;
		if (user.id === this.meta.spamFilterModeratorUserId) return false;
		if (user.isSuspended) return false;
		if (user.host != null && this.meta.spamFilterSkipHosts.includes(user.host)) return false;
		if (!this.isAccountInScope(user)) return false;
		return true;
	}

	@bindThis
	private isActioned(verdict: SpamVerdict): boolean {
		return verdict.label !== 'ham' && verdict.confidence >= this.thresholdFor(verdict.label);
	}

	@bindThis
	private thresholdFor(label: SpamLabel): number {
		switch (label) {
			case 'spam': return this.meta.spamFilterThresholdSpam;
			case 'ad': return this.meta.spamFilterThresholdAd;
			case 'phishing': return this.meta.spamFilterThresholdPhishing;
			default: return Infinity;
		}
	}

	@bindThis
	private async recordStrike(noteId: string | null, user: MiUser, verdict: SpamVerdict): Promise<void> {
		await this.spamLogsRepository.insert({
			id: this.idService.gen(),
			createdAt: new Date(),
			noteId,
			userId: user.id,
			userHost: user.host,
			label: verdict.label,
			score: verdict.confidence,
			reason: verdict.reason,
		});
	}

	@bindThis
	private async collectImageUrls(fileIds: string[]): Promise<string[]> {
		if (fileIds.length === 0) return [];
		const files = await this.driveFilesRepository.findBy({ id: In(fileIds) });
		return files
			.filter(f => f.type.startsWith('image/'))
			.map(f => f.webpublicUrl ?? f.url)
			.filter((u): u is string => u != null)
			.slice(0, this.meta.spamMaxImagesPerNote);
	}

	@bindThis
	private async classifySafely(text: string, imageUrls: string[], subject: string): Promise<SpamVerdict | null> {
		try {
			return await this.classify(text, imageUrls);
		} catch (err) {
			this.logger.warn(`spam classify failed for ${subject}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	@bindThis
	private async classify(text: string, imageUrls: string[]): Promise<SpamVerdict | null> {
		// The classifier is the local service server (no inbound auth). The vLLM it proxies to is
		// the shared "LLM server" configured in the admin panel — passed through so it's set once.
		const host = this.config.serviceServer?.host ?? '127.0.0.1';
		const port = this.config.serviceServer?.port ?? 3061;
		// Plain fetch (not httpRequestService): the service server is a loopback address, which
		// the federation HTTP client blocks as a private network.
		const res = await fetch(`http://${host}:${port}/classify`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				text,
				image_urls: imageUrls,
				vllm_url: this.meta.llmTranslateURL,
				vllm_key: this.meta.llmTranslateKey,
				model: this.meta.llmTranslateModel,
			}),
			signal: AbortSignal.timeout(this.meta.spamRequestTimeoutMs),
		});
		if (!res.ok) {
			this.logger.warn(`spam classifier returned HTTP ${res.status}`);
			return null;
		}

		const json = await res.json() as Partial<SpamVerdict>;
		if (json == null || typeof json.label !== 'string' || !(spamLabels as readonly string[]).includes(json.label)) {
			this.logger.warn(`spam classifier returned an unexpected payload: ${JSON.stringify(json)}`);
			return null;
		}
		const confidence = typeof json.confidence === 'number' ? Math.max(0, Math.min(1, json.confidence)) : 0;
		return {
			label: json.label as SpamLabel,
			confidence,
			reason: typeof json.reason === 'string' ? json.reason.slice(0, 1024) : null,
		};
	}

	@bindThis
	private async hidePrivate(note: { id: string; localOnly: boolean }, author: MiUser): Promise<void> {
		await this.notesRepository.update(note.id, {
			visibility: 'specified',
			visibleUserIds: [author.id],
		});

		this.globalEventService.publishNoteStream(note.id, 'deleted', {
			deletedAt: new Date(),
		});

		if (this.userEntityService.isLocalUser(author) && !note.localOnly) {
			try {
				const content = this.apRendererService.addContext(
					this.apRendererService.renderDelete(
						this.apRendererService.renderTombstone(`${this.config.url}/notes/${note.id}`),
						author,
					),
				);
				await this.apDeliverManagerService.deliverToFollowers(author, content);
				await this.relayService.deliverToRelays(author, content);
			} catch (err) {
				this.logger.warn(`failed to federate spam retraction for note ${note.id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	@bindThis
	private async notify(target: MiUser, text: string): Promise<void> {
		const moderator = await this.usersRepository.findOneBy({ id: this.meta.spamFilterModeratorUserId! });
		if (moderator == null) return;
		try {
			await this.noteCreateService.create(moderator, {
				text,
				visibility: 'specified',
				visibleUsers: [target],
			});
		} catch (err) {
			this.logger.warn(`failed to DM spam notice to ${target.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	@bindThis
	private async maybeSuspend(author: MiUser): Promise<void> {
		// Only local users are auto-suspended. Remote users still get each flagged post hidden and
		// strikes recorded, but we never ban the remote account itself: their home instance owns that
		// account's moderation, and suspending on repeated strikes is too easy to trip on federated
		// spam (and on our own classifier's false positives against another instance's users).
		if (!this.userEntityService.isLocalUser(author)) return;

		const windowStart = new Date(Date.now() - this.meta.spamWindowDays * DAY_MS);
		const count = await this.spamLogsRepository.countBy({
			userId: author.id,
			createdAt: MoreThanOrEqual(windowStart),
		});
		if (count < this.meta.spamCountThreshold) return;

		const moderator = this.meta.spamFilterModeratorUserId
			? await this.usersRepository.findOneBy({ id: this.meta.spamFilterModeratorUserId })
			: null;
		if (moderator == null) {
			this.logger.warn(`user ${author.id} reached the spam threshold but no moderator account is configured; skipping auto-suspend`);
			return;
		}

		this.logger.info(`auto-suspending @${author.username} after ${count} spam strikes`);
		await this.userSuspendService.suspend(author, moderator);

		await this.notify(author, 'Your account has been suspended for repeated spam. If you believe this is a mistake, please contact the moderators.').catch(() => {});
	}

	@bindThis
	public onApplicationShutdown(): void {
		this.internalEventService.off('localUserUpdated', this.onUserUpdated);
		this.internalEventService.off('remoteUserUpdated', this.onUserUpdated);
	}
}
