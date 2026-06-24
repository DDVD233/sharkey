<!--
SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

# Recommendation system

This folder implements Sharkey's personalized "For You" feed: an out-of-network discovery feed
(plus an interleaved in-network "follows" lane) built from note embeddings, LLM quality/topic
signals, collaborative & social-graph signals, and a two-stage learned ranker.

The public entry point is [`RecommendationService`](../RecommendationService.ts) (one folder up). It is a
thin **facade**: it keeps the exact public API the rest of the backend calls (endpoints, queue
processors, `NoteCreateService`/`ReactionService`) and delegates each method to one of the
collaborator services here. Splitting the old ~2900-line monolith into these services is purely
organizational — the algorithm is unchanged.

## Module map

| File | Class | Responsibility |
|---|---|---|
| `../RecommendationService.ts` | `RecommendationService` | Public facade; delegates to the collaborators below. The only service other modules inject. |
| `RecBlocklistService.ts` | `RecBlocklistService` | Admin recommendation blocklist (acct → ids, cached), serve-time safety net, hard purge. |
| `RecNoteFeaturesService.ts` | `RecNoteFeaturesService` | Per-note features: structural + LLM quality, topic classification, the high-quality discovery index, the Milvus quality eviction gate. |
| `RecInterestService.ts` | `RecInterestService` | Per-user interest model: engagement signals → interest vectors (Rocchio + EMA), author produce-centroids, topic interest, language affinity. |
| `RecFollowsService.ts` | `RecFollowsService` | The in-network "follows lane": home-timeline pull, boost resolution, follow↔interest sims, and the follows/modality interleavers. |
| `RecRetrievalService.ts` | `RecRetrievalService` | Note loading + visibility/mute/block filtering, language weighting, the recent-tail fallback, author spacing. |
| `RecRankingService.ts` | `RecRankingService` | The two-stage ranker (light → heavy), the additive factor model, the learned-ranker blend, and the "why recommended?" breakdown. |
| `RecCandidateService.ts` | `RecCandidateService` | Candidate generation: ANN + CF + social-graph retrieval, the quality gate, and `buildCandidateQueue` (the orchestrator that writes a user's Redis queue). |
| `RecServingService.ts` | `RecServingService` | `getPage` (logged-in + anonymous), queue pop / lazy rebuild / tail top-up, and impression logging. |
| `RecBackfillService.ts` | `RecBackfillService` | One-off / admin maintenance jobs (prefill embeddings, backfill quality/topics, seed cold users from history). |
| `constants.ts` | — | All hand-tuned weights and tunables (engagement weights, ANN caps, ranking weights, recency, language, modality). |
| `types.ts` | — | Shared types: `NoteFeatures`, `CandidateFeatures`, `ScoredCandidate`, and the client-facing `Recommendation*` breakdown types. |
| `math.ts` | — | `unit` (L2-normalize), `cosine`, `llmTo01`. |
| `lang.ts` | — | `normalizeLang` (strip region, collapse Chinese variants to `zh`). |

Two pure modules in the parent `core/` folder are shared with non-recommendation code and stay there:
`rec-topics.ts` (the fixed topic taxonomy), `rec-settings.ts` (per-user settings + `mergeRecSettings`),
`rec-ranker.ts` (the learned-ranker contract: features, engagement heads, `blendWeights`, `scoreWithModel`).

## How it fits together

```
  note created ──► EmbedNote job ──► embedding server ──► Milvus (mm / txt vectors)
                          │                                   ▲
                          └──► ScoreNote job ──► LLM ──► quality (1-5) + topic
                                                  │
                                   rec:feat:{note}, rec:hq:{lang}, note_topic
  ─────────────────────────────────────────────────────────────────────────────
  user engages (react / renote / reply / fav / post / dwell / "not interested")
        │                                   RecInterestService
        └──► rec:engaged, EMA nudge ──► interest vectors (rec:uvec), topics, lang affinity
  ─────────────────────────────────────────────────────────────────────────────
  GET feed ► RecServingService.getPage
        └─ rebuild? ► RecCandidateService.buildCandidateQueue
                         ├─ retrieve: ANN(Milvus) + CF + social + follows-lane
                         ├─ quality gate (drop q<2 / unscored, enqueue scoring)
                         ├─ RecRankingService.rankCandidates  (light → heavy)
                         └─ interleave follows + modalities ► rec:queue:{user}
        └─ pop page ► load+filter (RecRetrievalService) ► log impressions ► breakdowns
```

## Infrastructure & external services

- **Milvus** (vector store, two collections per concern — `mm` multimodal and `txt` text-only):
  note vectors (ANN retrieval), per-user interest vectors (CF neighbour search via
  `searchUsersByVector`), and per-author produce-centroids. Collections need an explicit HNSW index
  (AUTOINDEX is too slow for the feed). Accessed via `MilvusService`.
- **Embedding server** — an OpenAI-compatible `/v1/embeddings` endpoint (a multimodal model);
  embeds note text + downscaled image attachments. Driven by the `EmbedNote` queue processor.
- **LLM (vLLM)** — scores general-audience "interestingness" 1-5 and classifies a note's topic.
  Accessed via `LlmQualityService`; the prompt lives in admin meta, not in source.
- **Postgres** — `note_topic` (note → topic) and `note_recommendation_impression` (the training log:
  what was served, at what rank, with what features, and what the user later did).
- **Redis** (timelines instance) — all hot per-user state (see below).

Endpoints/hosts for Milvus, the embedding server, and the LLM are deployment config (control panel /
`.config`), not hardcoded here.

### Redis keys (timelines instance)

| Key | Type | Meaning |
|---|---|---|
| `rec:queue:{user}` | list | Ranked candidate queue, best-first; popped as served. |
| `rec:pushed:{user}` | zset | member=noteId score=pushedAt — source of truth for "don't repeat". |
| `rec:engaged:{user}` | list | Recent `${weight}:${noteId}` positive engagements (drives interest vectors + social hop-2). |
| `rec:uvec:{mm\|txt}:{user}` | string | Cached per-modality interest vector (JSON). |
| `rec:dirty:{user}` | string | Set when the interest vector needs a batch recompute. |
| `rec:disliked:{user}` | zset | Explicit "not interested" notes (strong negatives + excluded from feed). |
| `rec:replyengaged:{user}` | list | "Reply engaged by author" — the highest-value positive signal. |
| `rec:homeseen:{user}` | zset | Home-timeline notes already shown (so the follows lane doesn't re-surface them). |
| `rec:langaff:{user}` | hash | Per-language engagement counts → soft language weighting. |
| `rec:topicint:{user}` | string | Per-topic interest array `{topic: +1\|0\|-1}`. |
| `rec:cf:{user}` (+`rec:cf:lock`) | zset | Cached collaborative-filtering candidate pool (TTL, single-flighted). |
| `rec:social:{user}` (+`rec:social:lock`) | zset | Cached 2-hop social-graph candidate pool (TTL, single-flighted). |
| `rec:avec:{mm\|txt}:{author}` | string | Author produce-centroid: EMA over the author's own note embeddings. |
| `rec:avgvec:{mm\|txt}` | string | Instance-wide average interest vector (cold-start ANN query). |
| `rec:feat:{note}` | string | Cached per-note features (quality, structure, image flags). |
| `rec:hq:{lang}` | zset | Per-language high-quality discovery index (LLM q ≥ 4, recent). |
| `rec:users` | zset | Users with engagement (for the nightly batch vector recompute). |

## The offline content pipeline (how a note becomes a candidate)

When a note is created (and on a throttled backfill), two background jobs run:

1. **Embed** (`EmbedNote` processor → `RecInterestService.foldAuthorCentroid`,
   `RecNoteFeaturesService.recordNoteFeatures`): downscale image attachments, embed text+image, upsert
   the vector into Milvus (`mm` if it has an image, else `txt`), and fold the embedding into the
   author's produce-centroid.
2. **Score** (`ScoreNote` processor → `recordNoteFeatures` / `recordNoteTopic`): compute structural
   quality, ask the LLM for an interestingness score (1-5) and a topic. Results are cached in
   `rec:feat:{note}` and `note_topic`.

Quality gates retrieval in two places:
- Notes the LLM scores at the bottom (`q < RETRIEVAL_QUALITY_MIN`, i.e. q=1) are **evicted from Milvus**
  and kept out — they can never be an ANN candidate (and a 2-char post's embedding is unreliable).
- Notes the LLM scores highly (`q ≥ HQ_QUALITY_MIN` = 4) are indexed per language in `rec:hq:{lang}`,
  the discovery pool for cold users. (A 5 is vanishingly rare, so 4 is the effective top tier.)

Blocklisted authors are skipped at embed/score time and purged by `RecBlocklistService.purgeBlockedUsers`.

## The per-user interest model (`RecInterestService`)

Every positive engagement (`onPositiveEngagement`: react / renote / reply / favorite / own-post, plus the
high-value `onReplyEngagedByAuthor`) does two things: appends to `rec:engaged` with a signal weight
(reply > boost ≈ favorite ≈ own-post > rare reaction > normal reaction), and applies a small **EMA nudge**
to the user's interest vector toward the note's embedding. "Not interested" (`markNotInterested`) and
ignored-but-shown notes are negatives (Rocchio push-away; strong vs soft respectively).

A nightly batch (`recomputeInterestVectors` / `recomputeAllUserVectors`) authoritatively rebuilds each
vector as a **linear-decay-weighted mean** over the most recent engagements (positives pull toward,
negatives push away) and reconciles the between-rebuild EMA drift. Per modality (`mm`/`txt`), since image
and text embeddings live in different subspaces.

Alongside the vectors it derives: a **topic-interest array** (top engaged topics +1; news/politics −1 by
default), and **language affinity** (`rec:langaff`) used to soften/strengthen the language filter.

`getUserVector`-less (brand-new) users query ANN with the **instance-wide average user vector**
(`rec:avgvec`) so even a first session gets a personalized-*shaped* feed rather than generic popularity.

## Candidate generation (`RecCandidateService.buildCandidateQueue`)

Multiple out-of-network sources are retrieved and blended into one scored pool:

- **ANN** (primary): `MilvusService.searchByVector` with the user's interest vector (or the average vector
  when cold), per modality, excluding already-seen notes and muted/blocked authors at retrieval time.
- **CF** (taste-neighbours): find users whose interest vector is near this user's (`searchUsersByVector`),
  read what those *strangers* recently engaged, weight by `neighbourSim × engageWeight`. TTL-cached in
  `rec:cf`, computed off the serve path.
- **Social 2-hop** (UTEG analog): notes that people you *follow* recently engaged, weighted Real-Graph-lite
  by how much you actually engage each followee. TTL-cached in `rec:social`.
- **Follows lane**: the user's home-timeline (people they follow), boost-resolved, fetched up front. This
  is a *distinct* in-network lane — not scored into the discovery pool — interleaved post-ranking.

The pooled candidates pass a **quality gate** (drop q=1 and not-yet-scored notes, enqueuing scoring for the
latter; followed authors bypass the gate), a hard age cutoff (older than the Milvus retention window), then
go to the ranker. The top slice is written to `rec:queue:{user}`.

A cold/warm **confidence gate** `alpha = signal / (signal + K)` blends the feed from "almost purely
quality + freshness" (new user) toward "almost purely personal relevance" (veteran).

## Ranking (`RecRankingService.rankCandidates`)

Two stages, mirroring Earlybird → heavy ranker:

1. **Light** — a cheap relevance + quality + recency score, plus the language filter, trims the pool to
   the top `LIGHT_RANK_KEEP` (no centroid reads, no model eval).
2. **Heavy** — the full score for the survivors. The base is a **fully additive** sum of signed per-factor
   contributions, each `weight · rawSignal · userCoefficient`:
   relevancy (user↔note cosine), authorAffinity (user↔author-centroid cosine), quality, popularity,
   topicPreference, followed, similarUsers (CF/social), minus shortPost / overTag / reply penalties.
   Every factor is interpretable and balanced so none dominates; the user's per-factor coefficient (0–2)
   scales its contribution. **Recency** is a separate *multiplicative* time-decay gate (Hacker-News-style
   `1/(age+offset)^gravity`). A **learned ranker** (per-engagement logistic heads × value weights, see
   `rec-ranker.ts`) can be blended in via the admin λ (`recommendationRankerWeight`); λ=0 ⇒ pure hand-tuned,
   identical to pre-learned behaviour. Weights are blended once per build by `blendWeights`.

After scoring: an **author-diversity** penalty (each author's k-th note loses `k · penalty`, applied to the
score, not a forced reorder), and **modality interleaving** toward a ~1:1 image:text mix.

The exact per-note contributions are stored on the queue entry and reconstructed by `buildBreakdown` for the
client's "why recommended?" view — no re-ranking.

## Serving (`RecServingService.getPage`)

- **Logged-in**: rebuild the queue on feed-open (offset 0), explicit refresh, or low watermark; otherwise
  page the existing queue. Pop the page, top up from the recent matched-language tail if the queue runs dry
  mid-scroll, load+filter notes (visibility/mute/block/blocklist), log impressions (with served rank — a
  position-bias signal for training), and attach breakdowns. Rebuild preserves still-unseen queued notes and
  excludes already-pushed ones, so a refresh never repeats or discards unseen content.
- **Anonymous** (`getAnonymousPage`): pure ANN with the average-user vector, falling back to the recent
  matched-language tail. No impression logging.

The follows lane is interleaved into discovery at the user's `followedRatio` (default 0.3); at ratio ≥ 1 the
feed is follows-first and skips the expensive discovery retrieval when follows already fill the queue.

## Settings & blocklist

Per-user settings (`rec-settings.ts`): on/off, NSFW, per-factor coefficients, per-engagement-kind weights,
explicit interest/disinterest topics, `followedRatio`, language preferences. Read via
`getEffectiveRecSettings` (cached). The admin recommendation blocklist (`RecBlocklistService`) keeps specific
authors out of *everyone's* recommendations (it does not affect their own feed).

## Offline learning & maintenance

The learned ranker and various indexes are trained/rebuilt out-of-band by scripts in
`packages/backend/scripts/` (they talk to Postgres/Redis/Milvus directly, not through these services):

- `backfill-impression-features.mjs` — precompute & persist expensive ranker features (e.g. author-centroid
  sims via online-EMA replay) into the impression log, so the learner reads ready-made features from the DB.
- `learn-coef.mjs` — train the heavy ranker: per-engagement logistic heads over the impression log
  (pairwise within-user). Emits the model JSON loaded into admin meta; ramp it in by raising λ.
- `enqueue-topic-backfill.mjs`, `backfill-hq.mjs`, `build-user-topic-arrays.mjs`, `evict-lowq-milvus.mjs` —
  populate topics / the HQ index / per-user topic arrays, and prune low-quality vectors.

Admin endpoints under `server/api/endpoints/admin/recommendation/` trigger the in-service backfills
(`RecBackfillService`, `backfillAuthorCentroids`, `backfillHighQualityIndex`, `purgeBlockedUsers`, …).

## Design principles (where to tune)

- **Best-effort everywhere** — every Milvus/LLM call is guarded; the feed never hard-fails on their absence.
- **Nothing heavy on the serve path** — CF/social pools and interest vectors are precomputed and TTL-cached;
  `getPage` reads Redis and ranks an already-bounded pool.
- **Interpretable additive scoring** — tune `constants.ts` (`HAND_FACTOR_WEIGHTS` and friends) to change feed
  behaviour; every factor's effect is directly visible in the breakdown.
- **One confidence knob** (`CONFIDENCE_K`) governs the cold→warm transition instead of branchy special-casing.
