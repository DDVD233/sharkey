/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { parse as mfmParse } from 'mfm-js';
import type * as Mfm from 'mfm-js';

/**
 * Structural breakdown of a note's text, used as a cheap, deterministic content-quality signal
 * (and as the always-available fallback when the LLM quality score is missing). "Readable" length
 * counts only human-readable prose — URLs, #hashtags, @mentions and :emoji: shortcodes are NOT
 * readable: a post that is mostly tags or links carries little information and should score low.
 */
export type NoteTextAnalysis = {
	/** Characters of human-readable prose (text nodes only). */
	readableLength: number;
	/** Total characters of the raw source text. */
	totalLength: number;
	/** readableLength / totalLength ∈ [0,1]; low for link/tag/mention-heavy posts. */
	readableRatio: number;
	linkCount: number;
	hashtagCount: number;
	mentionCount: number;
	emojiCount: number;
};

function walk(nodes: Mfm.MfmNode[], acc: NoteTextAnalysis): void {
	for (const node of nodes) {
		switch (node.type) {
			case 'text':
			case 'quote':
				// plain prose contributes readable length
				if (node.type === 'text') acc.readableLength += [...node.props.text].length;
				break;
			case 'url':
			case 'link':
				acc.linkCount += 1;
				break;
			case 'hashtag':
				acc.hashtagCount += 1;
				break;
			case 'mention':
				acc.mentionCount += 1;
				break;
			case 'emojiCode':
			case 'unicodeEmoji':
				acc.emojiCount += 1;
				break;
			default:
				break;
		}
		// Recurse into children (bold, small, center, quote, link label, …) so nested prose still counts.
		const children = (node as { children?: Mfm.MfmNode[] }).children;
		if (children && children.length > 0) walk(children, acc);
	}
}

export function analyzeNoteText(text: string | null | undefined): NoteTextAnalysis {
	const acc: NoteTextAnalysis = {
		readableLength: 0,
		totalLength: text ? [...text].length : 0,
		readableRatio: 0,
		linkCount: 0,
		hashtagCount: 0,
		mentionCount: 0,
		emojiCount: 0,
	};
	if (text && text.length > 0) {
		try {
			walk(mfmParse(text), acc);
		} catch {
			// MFM parse failures fall back to treating the whole text as readable prose.
			acc.readableLength = acc.totalLength;
		}
	}
	acc.readableRatio = acc.totalLength > 0 ? Math.min(1, acc.readableLength / acc.totalLength) : 0;
	return acc;
}

// Readable-length reward peaks around PEAK_LEN characters (a comfortable paragraph — tuned for CJK,
// the dominant language here) and falls off for posts that are too short OR too long (a wall of text
// is as hard to read as a one-word post). It's a flat-topped bell in log-length: lengths within
// PLATEAU_LOG of the peak (≈ 80–120 chars) all score ~1, then it decays smoothly and symmetrically in
// log space (so it's non-linear — doubling or halving the length costs the same), down to LEN_FLOOR.
const PEAK_LEN = 100;
const PLATEAU_LOG = 0.2; // half-width of the flat top in natural-log units (≈ ±22% around the peak)
const LEN_SIGMA = 0.9; // log-units; larger = gentler falloff
export const LEN_FLOOR = 0.15; // very short / very long never score below this from length alone
// The readable-ratio penalty never zeroes a post out entirely — even a tag-only post keeps this floor.
const RATIO_FLOOR = 0.5;
// An image post with little/no text still carries information through the image.
const IMAGE_FLOOR = 0.55;

/** Flat-topped bell in log-length: ~1 over the plateau around PEAK_LEN, decaying both ways to LEN_FLOOR. */
export function lengthReward(readableLength: number): number {
	if (readableLength <= 0) return LEN_FLOOR;
	const logDist = Math.abs(Math.log(readableLength) - Math.log(PEAK_LEN));
	const beyondPlateau = Math.max(0, logDist - PLATEAU_LOG);
	const bell = Math.exp(-0.5 * (beyondPlateau / LEN_SIGMA) ** 2);
	return Math.max(LEN_FLOOR, bell);
}

/**
 * Deterministic content-quality score ∈ [0,1] from structure alone (no model). Rewards a readable
 * length near the sweet spot (peaks ~100 chars, penalizes very short and very long), scaled down by a
 * low readable-ratio (link/tag/mention dumps), with a floor for image posts. Used as the fallback
 * when the LLM interestingness score is absent.
 */
export function structuralQuality(analysis: NoteTextAnalysis, hasImage: boolean): number {
	const lenScore = lengthReward(analysis.readableLength);
	const ratioMult = RATIO_FLOOR + (1 - RATIO_FLOOR) * analysis.readableRatio;
	let q = lenScore * ratioMult;
	if (hasImage) q = Math.max(q, IMAGE_FLOOR);
	return Math.max(0, Math.min(1, q));
}
