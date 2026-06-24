/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Fixed topic taxonomy for the recommender. Each public note is assigned exactly one of these labels
 * by the LLM (see {@link LlmQualityService.classifyTopic}); per-user topic interest is derived from the
 * topics of the notes a user engages with.
 *
 * Labels are English slugs — both stored (in the `note_topic` table / used as the interest-array key)
 * AND emitted by the model: the classifier instruction-follows better in English even on non-English
 * content. Chinese labels are kept only as a parse fallback (if the model ever answers in Chinese for a
 * zh post). The slug list must stay stable (reorder OK; renaming a slug orphans existing rows).
 */
export const TOPIC_LABELS = [
	'anime', 'gaming', 'art', 'sports', 'drawing', 'humor', 'tech', 'home', 'food', 'photography',
	'science', 'study', 'travel', 'music', 'culture', 'emotion', 'career', 'social-science', 'literature',
	'news', 'programming', 'politics', 'pets', 'daily-life',
] as const;

export type Topic = (typeof TOPIC_LABELS)[number];

/**
 * Topics down-ranked by default in a user's interest array (set to -1) — unless the user engages with
 * them enough to land in their top-3, which overrides the penalty. News/politics dominate the raw feed
 * (≈20% news) and are mostly bot/mirror traffic, so they're suppressed by default.
 */
export const TOPIC_DOWNRANK_DEFAULT: readonly Topic[] = ['news', 'politics'];

// Extra aliases mapped back to a slug when the model doesn't emit the exact slug — English near-misses
// and Chinese labels (parse fallback). The slug itself is always accepted. Matched longest-first so
// "social-science"/"social science" win over a bare "science".
const TOPIC_ALIASES: Partial<Record<Topic, string[]>> = {
	gaming: ['gaming', 'games', 'game'],
	humor: ['humor', 'humour', 'comedy', 'meme', 'memes'],
	tech: ['tech', 'gadgets', 'consumer tech', 'digital', '科技数码'],
	emotion: ['emotion', 'emotions', 'relationships', 'relationship', '情感'],
	career: ['career', 'workplace', '职场'],
	// economy/finance map here too (our social-science bucket explicitly covers economics) — the model
	// occasionally emits these out-of-taxonomy labels instead of choosing the closest listed one.
	'social-science': ['social-science', 'social science', 'socialscience', 'economy', 'economics', 'economic', 'finance', 'financial', '社科'],
	literature: ['literature', 'fan-fiction', 'fanfiction', 'fanfic', 'fiction', 'writing', '文学创作', '同人文', '同人', '小说'],
	science: ['science', '科学科普'],
	news: ['news', 'current events', '新闻/时事', '新闻', '时事'],
	programming: ['programming', 'software', 'coding', 'code', 'dev', '编程/软件', '编程', '软件'],
	politics: ['politics', 'political', '政治'],
	pets: ['pets', 'pet', 'animals', 'animal', '宠物/动物', '宠物', '动物'],
	'daily-life': ['daily-life', 'daily life', 'dailylife', 'lifestyle', '日常/生活', '日常', '生活'],
};

// (slug + aliases) → slug, all lowercased; CJK lowercases to itself so one .includes() handles both.
const ALIAS_TO_LABEL: [string, Topic][] = [];
for (const label of TOPIC_LABELS) {
	const aliases = TOPIC_ALIASES[label] ?? [label];
	if (!aliases.includes(label)) aliases.unshift(label);
	for (const alias of aliases) ALIAS_TO_LABEL.push([alias.toLowerCase(), label]);
}
ALIAS_TO_LABEL.sort((a, b) => b[0].length - a[0].length);

/** Maps raw model output to a canonical slug, or null if nothing recognizable (an invalid answer). */
export function parseTopic(raw: string | null | undefined): Topic | null {
	const hay = (raw ?? '').trim().toLowerCase();
	if (!hay) return null;
	for (const [alias, label] of ALIAS_TO_LABEL) if (hay.includes(alias)) return label;
	return null;
}

/**
 * When the model responds but its output matches no slug, fall back to this residual bucket rather than
 * leaving the note unclassified — so every note that the model successfully answers for gets a (valid,
 * never-null) topic and is never re-classified. (A transient request failure is handled separately: the
 * classifier returns null there, and the caller persists nothing so a later run retries.)
 */
export const TOPIC_FALLBACK: Topic = 'daily-life';

/**
 * System prompt for single-topic classification (English, for instruction-following). Forces a choice
 * from the list (no "other"), one slug, no extra text. Disambiguation notes target confusable topics.
 */
export const TOPIC_SYSTEM_PROMPT = `You are a content classifier for social-media posts. Assign the post EXACTLY ONE topic from the fixed list below. You must choose from the list — never invent a topic and never answer "other". Output only the topic label itself, lowercase and exactly as written, with no numbering, punctuation, explanation, or extra text. The post may be in any language; the label is always one of these English slugs.

Topics:
${TOPIC_LABELS.join(', ')}

Disambiguation:
- daily-life: personal updates, mood, check-ins, greetings, small talk — anything with no clear specific topic.
- emotion: relationships, love, family/friendship, strong feelings (not ordinary small talk).
- literature: original writing, poetry, prose, fiction, and fan-fiction.
- tech: consumer electronics, gadgets, phones/computers/cameras and reviews (NOT writing code).
- programming: writing code, software development, programming languages, open-source projects.
- science: natural-science knowledge and explanation (physics/biology/astronomy, etc.).
- social-science: social science, economics, history, philosophy, academic discussion.
- news: reporting or relaying current events.
- politics: political issues, policy, elections, government.
- art: general art/design/aesthetics; drawing is specifically illustrations/paintings; photography is photos.`;
