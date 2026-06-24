/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Map the 1-5 LLM interestingness score into [0.2,1] (a "1" is poor, not worthless).
export const llmTo01 = (q: number): number => Math.max(0, Math.min(1, q / 5));

/** Returns the L2-normalized copy of a vector, or null if it's degenerate (zero norm). */
export const unit = (v: number[]): number[] | null => {
	let s = 0;
	for (const x of v) s += x * x;
	const norm = Math.sqrt(s);
	if (norm === 0) return null;
	return v.map(x => x / norm);
};

/** Cosine similarity of two equal-length unit (or near-unit) vectors; 0 on shape/degenerate mismatch. */
export const cosine = (a: number[], b: number[]): number => {
	if (a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
};
