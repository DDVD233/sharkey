/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';

/** A timeline note may carry the ad-insertion marker added by the pagination layer. */
export type TimelineNote = Misskey.entities.Note & { _shouldInsertAd_?: boolean };

export type NoteRenderUnit = {
	type: 'note';
	id: string;
	/** the note to render; also carries `_shouldInsertAd_` */
	note: TimelineNote;
} | {
	type: 'thread';
	id: string;
	/** the anchor (the member that appears earliest in the source list); carries `_shouldInsertAd_` */
	note: TimelineNote;
	/** chain members ordered oldest → newest (top → bottom) */
	notes: TimelineNote[];
};

function isMergeable(note: TimelineNote): boolean {
	// Pure renotes (boosts) are never folded into a thread.
	return !Misskey.note.isPureRenote(note);
}

/**
 * Groups a newest-first list of timeline notes so that runs of notes forming a
 * single *linear* reply chain (no branches, no parallel replies) collapse into a
 * single "thread" render unit. Everything else stays as an individual "note" unit.
 *
 * Only notes present in the input list are merged; the parent of a chain's oldest
 * member is left for the renderer to show as a truncated preview (via `note.reply`).
 *
 * @param notes  the loaded notes, newest first (as exposed by MkPagination)
 * @param enabled  when false, every note is returned as its own unit (current behavior)
 */
export function groupNoteThreads(notes: TimelineNote[], enabled: boolean): NoteRenderUnit[] {
	if (!enabled) {
		return notes.map(note => ({ type: 'note', id: note.id, note }));
	}

	const idToNote = new Map<string, TimelineNote>();
	const indexOf = new Map<string, number>();
	for (let i = 0; i < notes.length; i++) {
		idToNote.set(notes[i].id, notes[i]);
		indexOf.set(notes[i].id, i);
	}

	// A valid in-list parent for a note: loaded, mergeable, and linked via replyId.
	function loadedParent(note: TimelineNote): TimelineNote | null {
		if (!isMergeable(note) || note.replyId == null) return null;
		const parent = idToNote.get(note.replyId);
		if (parent == null || !isMergeable(parent)) return null;
		return parent;
	}

	// Count loaded children per parent so we can drop branches (a parent with 2+
	// loaded children does not form a single linear chain).
	const childCount = new Map<string, number>();
	for (const note of notes) {
		const parent = loadedParent(note);
		if (parent != null) childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1);
	}

	// A valid linear edge requires the parent to have exactly one loaded child.
	function chainParent(note: TimelineNote): TimelineNote | null {
		const parent = loadedParent(note);
		if (parent == null) return null;
		return childCount.get(parent.id) === 1 ? parent : null;
	}

	// Group members by their chain root (oldest reachable ancestor in the list).
	const rootOf = new Map<string, string>();

	function findRoot(note: TimelineNote): string {
		const cached = rootOf.get(note.id);
		if (cached != null) return cached;
		let cur = note;
		let parent = chainParent(cur);
		while (parent != null) {
			cur = parent;
			parent = chainParent(cur);
		}
		rootOf.set(note.id, cur.id);
		return cur.id;
	}

	const chains = new Map<string, TimelineNote[]>();
	for (const note of notes) {
		const root = findRoot(note);
		const arr = chains.get(root);
		if (arr) arr.push(note);
		else chains.set(root, [note]);
	}

	// anchorId -> ordered (oldest→newest) members, for chains with 2+ members.
	const threadByAnchor = new Map<string, TimelineNote[]>();
	const consumed = new Set<string>();
	for (const members of chains.values()) {
		if (members.length < 2) continue;
		const ordered = [...members].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : 1));
		// anchor = the member appearing earliest in the source list (top-most slot).
		let anchor = members[0];
		for (const m of members) {
			if ((indexOf.get(m.id) ?? 0) < (indexOf.get(anchor.id) ?? 0)) anchor = m;
		}
		threadByAnchor.set(anchor.id, ordered);
		for (const m of members) {
			if (m.id !== anchor.id) consumed.add(m.id);
		}
	}

	const units: NoteRenderUnit[] = [];
	for (const note of notes) {
		const thread = threadByAnchor.get(note.id);
		if (thread != null) {
			units.push({ type: 'thread', id: note.id, note, notes: thread });
		} else if (!consumed.has(note.id)) {
			units.push({ type: 'note', id: note.id, note });
		}
	}
	return units;
}
