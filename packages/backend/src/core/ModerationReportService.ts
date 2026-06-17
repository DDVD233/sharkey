/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In, MoreThanOrEqual } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { MiMeta, SpamLogsRepository, CsamQuarantineRepository, NotesRepository, DriveFilesRepository, UsersRepository } from '@/models/_.js';
import { EmailService } from '@/core/EmailService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import type Logger from '@/logger.js';

const DAY_MS = 86400_000;
const INLINE_LIMIT = 50;

@Injectable()
export class ModerationReportService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.spamLogsRepository)
		private spamLogsRepository: SpamLogsRepository,

		@Inject(DI.csamQuarantineRepository)
		private csamQuarantineRepository: CsamQuarantineRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private emailService: EmailService,
		loggerService: LoggerService,
	) {
		this.logger = loggerService.getLogger('moderation-report');
	}

	@bindThis
	private handle(userId: string, host: string | null, usernames: Map<string, string>): string {
		const name = usernames.get(userId) ?? userId;
		return host ? `@${name}@${host}` : `@${name}`;
	}

	@bindThis
	public async sendSpamDigest(): Promise<void> {
		const to = this.meta.moderationReportEmail;
		if (!to) return;

		const since = new Date(Date.now() - DAY_MS);
		const rows = await this.spamLogsRepository.find({
			where: { createdAt: MoreThanOrEqual(since) },
			order: { createdAt: 'DESC' },
		});

		if (rows.length === 0 && this.meta.moderationReportEmailSkipIfEmpty) return;

		const local = rows.filter(r => r.userHost == null).length;
		const remote = rows.length - local;

		// Enrich with usernames and image URLs.
		const usernames = await this.fetchUsernames(rows.map(r => r.userId));
		const fileUrlsByNote = await this.fetchNoteImageUrls(rows.map(r => r.noteId));

		const lines = rows.map(r => {
			const noteUrl = `${this.config.url}/notes/${r.noteId}`;
			const images = fileUrlsByNote.get(r.noteId) ?? [];
			const imgPart = images.length > 0 ? `\n  images: ${images.join(' , ')}` : '';
			return `- [${r.label} ${r.score.toFixed(2)}] ${this.handle(r.userId, r.userHost, usernames)} — ${noteUrl}${r.reason ? `\n  reason: ${r.reason}` : ''}${imgPart}`;
		});

		const subject = `[${this.config.host}] Spam filter daily report — ${rows.length} actions (local ${local} / remote ${remote})`;
		const summary = `Spam filter actions in the last 24h: ${rows.length} total (local ${local}, remote ${remote}).`;

		await this.deliver(to, subject, summary, lines, 'spam');
	}

	@bindThis
	public async sendCsamDigest(): Promise<void> {
		const to = this.meta.moderationReportEmail;
		if (!to) return;

		const since = new Date(Date.now() - DAY_MS);
		const rows = await this.csamQuarantineRepository.find({
			where: { createdAt: MoreThanOrEqual(since) },
			order: { createdAt: 'DESC' },
		});

		if (rows.length === 0 && this.meta.moderationReportEmailSkipIfEmpty) return;

		const local = rows.filter(r => r.userHost == null).length;
		const remote = rows.length - local;

		const usernames = await this.fetchUsernames(rows.map(r => r.userId).filter((id): id is string => id != null));

		// IMPORTANT: never link or attach the quarantined media itself.
		const lines = rows.map(r => {
			const reviewUrl = `${this.config.url}/admin/csam-quarantine/${r.id}`;
			const who = r.userId ? this.handle(r.userId, r.userHost, usernames) : '<unknown uploader>';
			const notePart = r.noteId ? ` note=${this.config.url}/notes/${r.noteId}` : '';
			return `- [${r.status}] source=${r.source} ${who} fileId=${r.fileId ?? '<deleted>'}${notePart}\n  review: ${reviewUrl}${r.reason ? `\n  reason: ${r.reason}` : ''}`;
		});

		const subject = `[${this.config.host}] CSAM filter daily report — ${rows.length} quarantines (local ${local} / remote ${remote})`;
		const summary = `CSAM filter quarantines in the last 24h: ${rows.length} total (local ${local}, remote ${remote}). These require immediate review and likely a CyberTipline (NCMEC) report. Media links are intentionally omitted.`;

		await this.deliver(to, subject, summary, lines, 'csam');
	}

	@bindThis
	private async deliver(to: string, subject: string, summary: string, lines: string[], kind: 'spam' | 'csam'): Promise<void> {
		const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
		let html: string;
		let text: string;
		let attachments: { filename: string; content: string; contentType?: string }[] | undefined;

		if (lines.length > INLINE_LIMIT) {
			const body = `${summary}\n\nFull list attached (${lines.length} entries).`;
			html = `<p>${summary}</p><p>Full list attached (${lines.length} entries).</p>`;
			text = body;
			attachments = [{
				filename: `${kind}-${dateTag}.txt`,
				content: `${summary}\n\n${lines.join('\n')}\n`,
				contentType: 'text/plain',
			}];
		} else {
			text = `${summary}\n\n${lines.join('\n')}\n`;
			const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			html = `<p>${summary}</p><pre style="white-space:pre-wrap">${esc(lines.join('\n'))}</pre>`;
		}

		try {
			await this.emailService.sendEmail(to, subject, html, text, attachments);
			this.logger.info(`sent ${kind} digest to ${to} (${lines.length} entries)`);
		} catch (err) {
			this.logger.error(`failed to send ${kind} digest: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	@bindThis
	private async fetchUsernames(userIds: string[]): Promise<Map<string, string>> {
		const ids = [...new Set(userIds)];
		if (ids.length === 0) return new Map();
		const users = await this.usersRepository.findBy({ id: In(ids) });
		return new Map(users.map(u => [u.id, u.username]));
	}

	@bindThis
	private async fetchNoteImageUrls(noteIds: string[]): Promise<Map<string, string[]>> {
		const ids = [...new Set(noteIds)];
		const result = new Map<string, string[]>();
		if (ids.length === 0) return result;

		const notes = await this.notesRepository.findBy({ id: In(ids) });
		const allFileIds = [...new Set(notes.flatMap(n => n.fileIds))];
		if (allFileIds.length === 0) return result;

		const files = await this.driveFilesRepository.findBy({ id: In(allFileIds) });
		const urlByFileId = new Map(files.filter(f => f.type.startsWith('image/')).map(f => [f.id, f.webpublicUrl ?? f.url]));

		for (const note of notes) {
			const urls = note.fileIds.map(fid => urlByFileId.get(fid)).filter((u): u is string => u != null);
			if (urls.length > 0) result.set(note.id, urls);
		}
		return result;
	}
}
