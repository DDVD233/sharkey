/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onMounted, onUnmounted, type Ref } from 'vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { $i } from '@/i.js';

// Notes glanced at for less than this don't count as a "good click".
const MIN_DWELL_MS = 600;
// How often accumulated dwell is flushed to the server.
const FLUSH_INTERVAL_MS = 15_000;
// Visibility threshold for an element to count as "on screen".
const VISIBLE_FRACTION = 0.5;

/**
 * Tracks how long each recommended note stays on screen and reports it to
 * `notes/recommendations/dwell`, where it's folded into the impression log as the "good click" training
 * signal for the learned ranker (the recommendation analog of Twitter's good_click / dwell engagement).
 *
 * Self-contained: it observes every `[data-scroll-anchor]` element inside `rootElRef` (the per-note
 * wrappers `MkNotes` already renders), accumulates visible time per note id, and batches updates on a
 * timer / when the tab is hidden / on unmount. No changes to the note components are needed. No-op for
 * logged-out users (the endpoint requires credentials).
 */
export function useRecommendationDwell(rootElRef: Readonly<Ref<HTMLElement | null>>): void {
	if ($i == null) return; // anonymous: nothing to attribute / endpoint requires credentials

	const visibleSince = new Map<string, number>(); // noteId → timestamp it became visible (ms, perf clock)
	const accumulated = new Map<string, number>(); // noteId → dwell ms not yet flushed
	let io: IntersectionObserver | null = null;
	let mo: MutationObserver | null = null;
	let flushTimer: number | null = null;

	const idOf = (el: Element): string | null => el.getAttribute('data-scroll-anchor');

	// Credit currently-visible notes up to `now`, leaving them visible (reset their start to now).
	function harvest(now: number): void {
		for (const [id, since] of visibleSince) {
			accumulated.set(id, (accumulated.get(id) ?? 0) + (now - since));
			visibleSince.set(id, now);
		}
	}

	function flush(): void {
		harvest(performance.now());
		const items: { noteId: string; dwellMs: number }[] = [];
		for (const [id, ms] of accumulated) {
			if (ms >= MIN_DWELL_MS) items.push({ noteId: id, dwellMs: Math.min(3_600_000, Math.round(ms)) });
		}
		accumulated.clear();
		if (items.length === 0) return;
		// Batched in chunks of 50 (the endpoint's per-call cap).
		for (let i = 0; i < items.length; i += 50) {
			misskeyApi('notes/recommendations/dwell', { items: items.slice(i, i + 50) }).catch(() => { /* best-effort */ });
		}
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === 'hidden') flush();
	}

	onMounted(() => {
		const root = rootElRef.value;
		if (root == null) return;

		io = new IntersectionObserver(entries => {
			const now = performance.now();
			for (const e of entries) {
				const id = idOf(e.target);
				if (id == null) continue;
				if (e.isIntersecting) {
					if (!visibleSince.has(id)) visibleSince.set(id, now);
				} else {
					const since = visibleSince.get(id);
					if (since != null) {
						accumulated.set(id, (accumulated.get(id) ?? 0) + (now - since));
						visibleSince.delete(id);
					}
				}
			}
		}, { threshold: VISIBLE_FRACTION });

		const observeAll = (): void => {
			root.querySelectorAll('[data-scroll-anchor]').forEach(el => io?.observe(el));
		};
		observeAll();
		// Pagination appends more notes over time — observe newcomers as they mount.
		mo = new MutationObserver(observeAll);
		mo.observe(root, { childList: true, subtree: true });

		flushTimer = window.setInterval(flush, FLUSH_INTERVAL_MS);
		document.addEventListener('visibilitychange', onVisibilityChange);
	});

	onUnmounted(() => {
		flush();
		io?.disconnect();
		mo?.disconnect();
		if (flushTimer != null) window.clearInterval(flushTimer);
		document.removeEventListener('visibilitychange', onVisibilityChange);
	});
}
