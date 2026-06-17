/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, MoreThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiMeta, NotesRepository, UsersRepository, DriveFilesRepository, SpamLogsRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { SpamLabel } from '@/models/SpamLog.js';
import { spamLabels } from '@/models/SpamLog.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
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

type SpamVerdict = {
	label: SpamLabel;
	confidence: number;
	reason: string | null;
};

@Injectable()
export class SpamFilterService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.spamLogsRepository)
		private spamLogsRepository: SpamLogsRepository,

		private httpRequestService: HttpRequestService,
		private globalEventService: GlobalEventService,
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
	}

	@bindThis
	public async checkNote(noteId: string): Promise<void> {
		if (!this.meta.enableSpamFilter || !this.meta.spamFilterServerUrl) return;

		const note = await this.notesRepository.findOneBy({ id: noteId });
		if (note == null) return;

		// Idempotency: never act on the same note twice.
		if (await this.spamLogsRepository.existsBy({ noteId })) return;

		const author = await this.usersRepository.findOneBy({ id: note.userId });
		if (author == null) return;

		// Skip conditions.
		if (isSystemAccount(author)) return;
		if (author.id === this.meta.spamFilterModeratorUserId) return;
		if (author.isSuspended) return;
		// Large, well-moderated servers are skipped entirely (saves compute).
		if (author.host != null && this.meta.spamFilterSkipHosts.includes(author.host)) return;

		// Only scan accounts younger than the configured age (defensive re-check).
		const accountAgeMs = Date.now() - this.idService.parse(author.id).date.getTime();
		if (accountAgeMs >= this.meta.spamAccountMaxAgeDays * 86400_000) return;

		// Gather scannable content.
		const hasText = (note.text ?? '').trim().length > 0;
		const imageUrls = await this.collectImageUrls(note.fileIds);
		if (!hasText && imageUrls.length === 0) return;

		// Call the external classifier (fail-open on any error).
		let verdict: SpamVerdict | null;
		try {
			verdict = await this.classify(note.text ?? '', imageUrls);
		} catch (err) {
			this.logger.warn(`spam classify failed for note ${noteId}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (verdict == null) return;

		const threshold = this.thresholdFor(verdict.label);
		if (verdict.label === 'ham' || verdict.confidence < threshold) return;

		// Record the strike (audit + rolling-window source).
		await this.spamLogsRepository.insert({
			id: this.idService.gen(),
			createdAt: new Date(),
			noteId: note.id,
			userId: author.id,
			userHost: author.host,
			label: verdict.label,
			score: verdict.confidence,
			reason: verdict.reason,
		});

		this.logger.info(`flagged note ${note.id} by @${author.username}${author.host ? '@' + author.host : ''} as ${verdict.label} (${verdict.confidence.toFixed(2)})`);

		// Hide the note (author-only) and retract any federated copy.
		await this.hidePrivate(note, author);

		// DM the author from @dvd — local users only.
		if (this.userEntityService.isLocalUser(author) && this.meta.spamFilterModeratorUserId) {
			await this.notifyAuthor(author, verdict.label, note.id);
		}

		// Rolling-window suspension.
		await this.maybeSuspend(author);
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
	private async classify(text: string, imageUrls: string[]): Promise<SpamVerdict | null> {
		const base = this.meta.spamFilterServerUrl!.replace(/\/+$/, '');
		const res = await this.httpRequestService.send(`${base}/classify`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(this.meta.spamFilterApiKey ? { Authorization: `Bearer ${this.meta.spamFilterApiKey}` } : {}),
			},
			body: JSON.stringify({ text, image_urls: imageUrls, model: this.meta.spamFilterModel }),
			timeout: this.meta.spamRequestTimeoutMs,
		}, {
			throwErrorWhenResponseNotOk: true,
		});

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
	private async hidePrivate(note: { id: string; localOnly: boolean; mentionedRemoteUsers: string; renoteUserId: string | null }, author: MiUser): Promise<void> {
		await this.notesRepository.update(note.id, {
			visibility: 'specified',
			visibleUserIds: [author.id],
		});

		this.globalEventService.publishNoteStream(note.id, 'deleted', {
			deletedAt: new Date(),
		});

		// Retract the federated copy with an AP Delete — only possible for local authors.
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
	private async notifyAuthor(author: MiUser, label: SpamLabel, noteId: string): Promise<void> {
		const moderator = await this.usersRepository.findOneBy({ id: this.meta.spamFilterModeratorUserId! });
		if (moderator == null) return;
		const noteUrl = `${this.config.url}/notes/${noteId}`;
		try {
			await this.noteCreateService.create(moderator, {
				text: `Hi — your recent post was automatically detected as ${label} and has been set to private, so it is no longer visible to others:\n${noteUrl}\n\nThis was an automated moderation action. If you believe this is a mistake or have any questions, please reply to this post and a moderator will take a look.`,
				visibility: 'specified',
				visibleUsers: [author],
			});
		} catch (err) {
			this.logger.warn(`failed to DM spam notice to ${author.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	@bindThis
	private async maybeSuspend(author: MiUser): Promise<void> {
		const windowStart = new Date(Date.now() - this.meta.spamWindowDays * 86400_000);
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

		this.logger.info(`auto-suspending @${author.username}${author.host ? '@' + author.host : ''} after ${count} spam strikes`);
		await this.userSuspendService.suspend(author, moderator);

		// Notice — local authors only.
		if (this.userEntityService.isLocalUser(author)) {
			try {
				await this.noteCreateService.create(moderator, {
					text: 'Your account has been suspended for repeated spam. If you believe this is a mistake, please contact the moderators.',
					visibility: 'specified',
					visibleUsers: [author],
				});
			} catch {
				// best-effort; the account is being suspended anyway
			}
		}
	}
}
