/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type CandidateSource = 'ann' | 'perUser' | 'quality' | 'global' | 'following' | 'fallback' | 'cf' | 'social';

export type EngagementKind = 'reaction' | 'renote' | 'reply' | 'favorite' | 'post';

/**
 * Relative strength of each positive signal when building the interest vector.
 * Reply > Boost(renote) > rare(custom) reaction > normal reaction. A bookmark/favorite is an
 * intentional save, weighted alongside a boost. (Notes shown but not engaged with are implicit
 * negatives — captured in the impression log for future ranker training, not here.)
 */
export const REPLY_WEIGHT = 3;

export const RENOTE_WEIGHT = 2;

export const FAVORITE_WEIGHT = 2;

export const POST_WEIGHT = 2;

export const REACTION_RARE_WEIGHT = 1.5;

export const REACTION_NORMAL_WEIGHT = 1;

// "Reply engaged by author" — the viewer replied to a note and its author engaged the reply back. The
// single highest-value positive in Twitter's heavy ranker; we nudge the viewer's interest vector toward
// that note harder than an ordinary engagement (a confirmed-good recommendation).
export const REPLY_ENGAGED_NUDGE_WEIGHT = 4;

// Tunables for candidate generation / ranking.
export const ENGAGED_MAX = 200;

export const ANN_TOPK = 1000;

export const ANN_EXCLUDE_CAP = 8000;

export const AUTHOR_EXCLUDE_CAP = 5000;

// Average-user interest vector: the mean of a random sample of users' interest vectors, used as the ANN
// query for brand-new / vector-less users so they still get a personalized-shaped feed (the "typical
// user's interests") instead of a generic quality/news pool. Cached instance-wide and recomputed lazily.
export const AVGVEC_SAMPLE_MAX = 200;

export const AVGVEC_TTL_SEC = 60 * 60 * 6;

export const FEATURED_THRESHOLD = 100;

// High-quality discovery pool (replaces the old global-trending source). We index recent notes the
// LLM scored highly and retrieve from that pool, so candidate generation itself is quality-gated.
// The LLM almost never awards a 5 (≈0.02% of notes in practice), so the effective "top tier" is q≥4
// (~14% of notes). Old trending is no longer used as a candidate source.
export const HQ_QUALITY_MIN = 4;

// Notes the LLM scores at the very bottom of the interestingness scale (q < this) carry no discovery
// value — and a 2-char post's embedding is unreliable, so a spuriously high ANN cosine could otherwise
// surface pure noise. We keep them OUT of the vector store entirely: the score job evicts them from
// Milvus and the embed job skips re-adding them, so they can never be an ANN candidate. ~39% of scored
// notes are q=1, so this also keeps the ANN collections substantially smaller/faster. Followed authors'
// posts are unaffected — they're surfaced via the `following` source, not ANN retrieval.
export const RETRIEVAL_QUALITY_MIN = 2;

export const HQ_WINDOW_MS = 1000 * 60 * 60 * 24 * 14;

export const HQ_POOL_LIMIT = 800;

// Cold retrieval: until a user has accumulated this much engagement signal, their interest vector is
// too sparse/noisy to trust, so we DON'T run personalized ANN retrieval (which would pull arbitrary-
// quality posts matching a half-formed vector). Instead the whole candidate pool is the q≥4 index, so
// early users are always ranked over high-quality content only. ~10 ≈ "fewer than ~10 reactions".
export const COLD_RETRIEVAL_MAX_SIGNAL = 10;

export const QUEUE_LOW_WATERMARK = 12;

// Max ranked notes persisted to a user's queue. The queue is popped 15-at-a-time and rebuilt on every
// feed-open / refresh / low-watermark, so it only needs to cover a session's worth of infinite scroll —
// keeping the full ~3k ranked set was pure waste: it ballooned the next rebuild's candidate pool (the
// whole queue is carried forward and re-loaded+re-scored) for a tail that's re-retrieved fresh anyway.
export const QUEUE_MAX_STORE = 300;

export const QUEUE_TTL_SEC = 60 * 60 * 24;

export const PUSHED_TTL_SEC = 60 * 60 * 24 * 30;

// The final score is a fully ADDITIVE (linear) sum of signed per-factor contributions — each factor is
// `weight · rawSignal · userCoefficient`, and the total is just their sum, so every factor's effect is
// directly interpretable (see {@link RecommendationService.buildBreakdown} and the "why recommended?"
// view). Weights are deliberately balanced so no single factor can dominate a post's ranking.
// Recency is a MULTIPLICATIVE time-decay on the whole score (the classic news-feed approach — cf. Hacker
// News `1/(age+offset)^gravity`), so age discounts a post regardless of how relevant/high-quality it is.
// Power-law with HN's gravity (1.8), offset tuned to a days-scale feed (≈2-day half-life): fresh ×1.00,
// 1 day ×0.68, 2 days ×0.50, 1 week ×0.17, 1 month ×0.02. The personal recency coefficient scales this as
// a deviation from 1 (coef 0 → no decay, 1 → full, 2 → exaggerated), never a raw multiply by the coef.
export const RECENCY_OFFSET_HOURS = 100;

export const RECENCY_GRAVITY = 1.8;

// Structural penalties (additive, SUBTRACTED). Posts with enough prose to stand on their own aren't
// penalized; very short posts lose up to W_SHORT (scaled by how short). Image posts are EXEMPT (the
// image carries the information without needing words).
export const W_SHORT = 0.20;

// Over-tagging is spam-adjacent: posts beyond TAG_SOFT_MAX hashtags lose up to W_TAG, reaching the full
// penalty TAG_PENALTY_RANGE tags over the limit.
export const TAG_SOFT_MAX = 3;

export const W_TAG = 0.50;

export const TAG_PENALTY_RANGE = 5;

// Replies shown alone lack the conversation they were written in, so subtract W_REPLY in the discovery
// feed — except self-reply thread continuations (the client merges those with their parent note).
export const W_REPLY = 0.20;

// Implicit negatives (notes shown but not engaged) are treated as VERY soft negatives via Rocchio:
// the user may simply not have bothered to react. A small coefficient nudges away from skipped
// content without ever overpowering an actual like.
export const SOFT_NEGATIVE_WEIGHT = 0.15;

export const NEG_SAMPLE_MAX = 100;

// Explicit "not interested" dislikes are STRONG negatives (unlike the soft, merely-ignored ones above):
// they pull the interest vector much harder on rebuild, are excluded from the feed, and are recorded
// (rec:disliked) as strong-negative training labels. The instant push-away uses DISLIKE_EMA_WEIGHT.
export const STRONG_NEGATIVE_WEIGHT = 0.5;

export const DISLIKE_SAMPLE_MAX = 50;

export const DISLIKE_EMA_WEIGHT = 3;

// Interest-vector weighting. The authoritative batch rebuild uses a LINEAR-decay-weighted mean over the
// most recent INTEREST_WINDOW engagements (so older interactions keep real weight: ~2% most-recent, ~1%
// at the 50th-back, not the steep EMA crush). The real-time per-like nudge uses a deliberately small EMA
// alpha so it's a gentle between-rebuild approximation that the batch then reconciles.
export const INTEREST_WINDOW = 100;

export const EMA_ALPHA = 0.02;

// Flat additive bonus when a candidate's author is someone the user follows — so followed people's
// posts surface near the top, even across languages, without drowning out discovery.
export const W_FOLLOW = 0.50;

// Author-diversity penalty: applied to the SCORE (not a reorder) so one prolific author can't dominate
// the feed. Greedily emitting best-first, each author's k-th note has k·this subtracted, so subsequent
// notes from the same author must be substantially better to stay near the top. Everything remains ranked
// by the (diversity-adjusted) score.
export const AUTHOR_DIVERSITY_PENALTY = 0.20;

// --- Two-stage ranking (light ranker → heavy ranker) --------------------------------------------
// Mirrors Twitter's Earlybird(light) → heavy-ranker split. After the quality gate, a CHEAP light score
// (relevance + quality + recency, no author-centroid reads, no model eval) trims the candidate set to
// the top LIGHT_RANK_KEEP before the expensive heavy ranker (author-similarity prior + learned model)
// runs. Bounds the per-build cost (centroid reads + model evals) without changing the top of the feed,
// since the dropped tail is the cheap-score worst and is re-retrieved fresh next rebuild anyway.
export const LIGHT_RANK_KEEP = 600;

// The additive ranking score is `Σ_factor weight_factor · rawSignal_factor · userCoeff_factor` (× the
// multiplicative recency gate). `HAND_FACTOR_WEIGHTS` are the SIGNED hand-tuned weights (penalties carry a
// negative sign so every raw signal is fed as its positive magnitude); the learned model supplies a
// learned weight per factor (via FACTOR_TO_FEATURE), and {@link blendWeights} interpolates the two by the
// admin blend λ. Recency is NOT here — it stays the separate multiplicative gate. The user's per-factor
// coefficient always scales the CONTRIBUTION (weight·raw·coeff), so user control is identical whether the
// weights are hand-tuned or learned.
export const ADDITIVE_FACTORS = ['relevancy', 'authorAffinity', 'quality', 'popularity', 'shortPostPenalty', 'overTagPenalty', 'replyPenalty', 'topicPreference', 'followed', 'similarUsers'] as const;

export type AdditiveFactor = typeof ADDITIVE_FACTORS[number];

// --- Topic interest -----------------------------------------------------------------------------
// Each user has a per-topic interest array of {+1, 0, -1} (rec:topicint:{userId}): their top-N engaged
// topics are +1, news/politics are -1 by default (unless they're top-N), everything else 0. At rank
// time a candidate's stored topic looks up that value and ADDS W_TOPIC·v to the score (a liked topic
// +W_TOPIC, a down-ranked one −W_TOPIC, neutral nothing).
export const W_TOPIC = 0.30;

export const TOPIC_TOP_N = 3;

// --- Relevance terms (note-similarity + author-similarity) --------------------------------------
// Two additive relevance signals: the user↔note cosine ("does this specific note match me") and a
// user↔author-centroid cosine ("does this author generally post things I like"). The note term is the
// primary relevance signal; the author term is a lower-variance prior that denoises one-off matches and
// gives non-followed authors a content-based affinity signal. Each contributes additively.
export const W_NOTE = 0.20;

export const W_AUTHOR = 0.20;

// Neutral similarity used when a candidate's user↔note cosine wasn't computed — i.e. it came from a
// non-ANN source (quality pool, following, CF, fallback) rather than personalized ANN retrieval. Using
// 0.5 ("unknown / average") instead of 0 stops those notes from being treated as maximally dissimilar.
export const NEUTRAL_SIM = 0.5;

// Per-author produce centroid: an EMA over the embeddings of the author's own posted notes, kept in
// Redis (`rec:avec:{mm,txt}:{authorId}` = JSON {v: unit vector, n: post count}), folded incrementally
// as each note is embedded. EMA (not a cumulative mean) so it tracks an author's CURRENT themes and an
// account that pivots topics doesn't stay anchored to its history forever.
export const AUTHOR_CENTROID_EMA_ALPHA = 0.02;

export const AUTHOR_HISTORY_CAP = 500;

// Until an author has this many embedded posts their centroid is too noisy to trust, so authorSim
// falls back to the note-sim (no author prior applied). Kept low (2) so the author prior actually
// diverges from note-sim for most authors — at 1 the centroid would just be the note itself.
export const AUTHOR_CENTROID_MIN_NOTES = 2;

// --- Collaborative-filtering retrieval (Tier B) -------------------------------------------------
// "Users with an interest vector like mine engaged with these notes." Added to the candidate mix as a
// source and given a flat additive bonus (like the follow bonus, but weaker) so taste-neighbour finds
// surface without being forced in via a fixed slot quota — they compete on the unified score with a
// thumb on the scale. Computed OFF the serve path (background, TTL-cached) so serving only ever reads
// one Redis key — cheap under concurrency.
// Flat bonus for a candidate surfaced by collaborative/social signal — taste-neighbours (CF) OR people
// you follow (social 2-hop) engaged it. Weaker than W_FOLLOW (someone you chose to follow), but raised
// from 0.15 so these out-of-network-but-socially-proofed notes actually compete for a slot.
export const W_CF = 0.30;

export const CF_NEIGHBORS = 50;

export const CF_PER_NEIGHBOR_NOTES = 50;

export const CF_POOL_LIMIT = 200;

export const CF_TTL_SEC = 60 * 60 * 6;

export const CF_LOCK_TTL_SEC = 120;

// --- Social-graph 2-hop retrieval (Twitter UTEG / GraphJet analog) -------------------------------
// "Notes that people you FOLLOW recently engaged with" — the genuine out-of-network social-proof signal
// (distinct from the embedding-CF source above, whose neighbours are taste-similar STRANGERS). Hop 1 is
// your follow graph, weighted Real-Graph-lite by how much you actually engage each followee; hop 2 reads
// each top followee's `rec:engaged` list (already maintained). A note's score = Σ over follows who
// engaged it of (followeeWeight × engageWeight) — UTEG's "# of weighted users who liked it". Computed off
// the serve path (TTL-cached in `rec:social:{userId}`), like CF, so serving only reads one zset.
export const SOCIAL_HISTORY_DAYS = 30;

export const SOCIAL_BASE_WEIGHT = 1;

export const SOCIAL_MAX_FOLLOWS = 2000;

export const SOCIAL_FANOUT = 150;

export const SOCIAL_PER_FOLLOW_NOTES = 50;

export const SOCIAL_POOL_LIMIT = 200;

export const SOCIAL_TTL_SEC = 60 * 60 * 6;

export const SOCIAL_LOCK_TTL_SEC = 120;

// Freshness window for CF/social HOP-2 candidate NOTES: a note your network engaged is only a candidate
// if the note itself is this recent. Without it the pools fill with weeks-old notes (your follow liked an
// old post today) that the multiplicative recency gate then crushes to ~0 — so the bonus never counts.
// Hop-1 weighting still looks back SOCIAL_HISTORY_DAYS; only the candidate notes are freshened.
export const CANDIDATE_FRESH_DAYS = 10;

// Soft language preference. The user's chosen language always carries at least BASE_SELECTED_LANG
// weight; other languages earn weight in proportion to how much the user actually likes them, so a
// "selected zh but always likes ja" user sees more ja over time and the language filter softens.
export const BASE_SELECTED_LANG = 0.7;

export const NULL_LANG_WEIGHT = 0.2;

// Cross-language weighting is a smooth, conservative curve (no hard cutoff): a non-selected language
// only earns meaningful weight when it both dominates the user's likes (logistic in share, centred
// at ~90%) AND there's enough signal to be significant (sample confidence ~total/(total+K)). Below
// that it tapers continuously toward zero.
export const CROSS_LANG_SHARE_MIDPOINT = 0.9;

export const CROSS_LANG_SHARE_TEMP = 0.05;

export const CROSS_LANG_SAMPLE_K = 1000;

// Image (multimodal) and text-only embeddings live in different vector subspaces and are matched
// separately (two Milvus collections). The image:text MIX of the feed is enforced by interleaving the
// two streams toward MODALITY_TARGET_IMAGE (≈1:1, capped by supply) — see below.
// Once a user has this much engagement signal, we trust their language(s) and stop mixing in
// undetected-language notes — which are frequently NOT in their language and read as noise.
export const STRICT_LANG_MIN_AFFINITY = 5;

// Follow-graph as a candidate source / interest seed.
export const FOLLOWED_RECENT_DAYS = 7;

// Follows lane: the followed-author share of the feed comes from the user's home-timeline cache (latest
// posts from people they follow), interleaved into the score-ranked discovery feed at their per-user
// `followedRatio` (default 0.3, range 0..0.9). It's a DISTINCT lane from discovery — fresh follows are
// ordered by recency and are NOT scored/recency-crushed, so they never get buried for being "low score".
export const FOLLOW_LANE_MAX = 200;

export const FOLLOW_SEED_MAX = 100;

export const FOLLOW_SEED_WEIGHT = 0.5;

// --- Quality-prior & cold/warm blend -----------------------------------------------------------
// Per-note features (quality, structure) are computed once off the hot path and cached here. They
// outlive the 60-day vector window slightly so a note is never ranked without its features.
export const FEATURE_TTL_SEC = 60 * 60 * 24 * 65;

// The whole ranking collapses to: score = alpha·relevance + (1−alpha)·qualityPrior, with alpha = n/(n+CONFIDENCE_K).
// `n` is the user's accumulated engagement signal. A brand-new user (n≈0) is served almost purely on
// quality + freshness (no personal signal to trust yet); a veteran (n≫K) almost purely on personal
// relevance ("catch up with friends / things I like"). One interpretable knob replaces the old
// cold-start branches. K ≈ the engagement mass at which personalization reaches half weight.
export const CONFIDENCE_K = 20;

// Content quality (LLM interestingness / structural fallback) and popularity (engagement) are intrinsic
// per-note value signals, each ADDED independently to the score. Quality is the trustworthy primary
// signal; popularity is now a first-class signal (raised from 0.15) so well-engaged notes rank
// meaningfully higher. (Freshness is the separate multiplicative recency decay.)
export const QP_QUALITY = 0.25;

export const QP_ENGAGEMENT = 0.30;

// SIGNED hand-tuned weight per additive factor (penalties negative). The blended-with-learned version of
// this map is what {@link RecommendationService.rankCandidates} multiplies into each factor's raw signal.
export const HAND_FACTOR_WEIGHTS: Record<AdditiveFactor, number> = {
	relevancy: W_NOTE,
	authorAffinity: W_AUTHOR,
	quality: QP_QUALITY,
	popularity: QP_ENGAGEMENT,
	shortPostPenalty: -W_SHORT,
	overTagPenalty: -W_TAG,
	replyPenalty: -W_REPLY,
	topicPreference: W_TOPIC,
	followed: W_FOLLOW,
	similarUsers: W_CF,
};

// Image:text MIX is enforced by INTERLEAVING the two score-sorted streams toward this image share
// (≈1:1), capped by supply: every window of the feed — including the first batch — gets the target mix
// while both modalities last; once one runs out the other fills the rest. This replaces the old
// "guarantee a floor of the total" approach, which kept the totals balanced but let the higher-scoring
// modality cluster at the front (e.g. an all-image first page even when the pool is mostly text).
export const MODALITY_TARGET_IMAGE = 0.5;
