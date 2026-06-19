# Sharkey service server (+ CSAM filter docs)

`service-server/app.py` is one small FastAPI process that provides the CPU-light helpers the
Sharkey backend calls on localhost. The Sharkey backend **boot spawns and supervises it**, so it
runs inside the same pm2 process — no Docker, nothing separate to start. Enable it in the backend
config (`serviceServer` block).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness → `{"ok": true}` |
| `POST /detect` | language detection via [lingua-py](https://github.com/pemistahl/lingua-py) (CPU only). `{text}` → `{lang, confidence}`. Result is stored on `note.lang`. |
| `POST /classify` | spam/ad/phishing classification. Proxies to the **LLM server** (a remote vLLM); the vLLM endpoint/key/model are passed in the request by Sharkey, so they're configured in exactly one place. `{text, image_urls, vllm_url, vllm_key, model}` → `{label, confidence, reason}`. |

## Topology

- **LLM server** = a remote OpenAI-compatible vLLM (on the GPU host), protected by a bearer key
  (`--api-key`). It backs **both** LLM note-translation (Sharkey → vLLM directly) and the spam
  filter (Sharkey → local `/classify` → vLLM). Configured once in the admin **Control Panel →
  Settings → External Services → LLM server** (endpoint, key, model), plus per-feature toggles.
- **Service server** = this local FastAPI, `http://127.0.0.1:<serviceServer.port>` (default 3061).
  Spam `/classify` and language `/detect` live here. Lingua is a CPU library — no GPU/LLM.

## Setup

Install Python deps once (used by the boot-spawned process):

```bash
pip install --user -r service-server/requirements.txt
```

Backend config (`.config/default.yml`):

```yaml
serviceServer:
  enabled: true
  host: '127.0.0.1'
  port: 3061
  pythonPath: 'python3'   # or a venv python
```

Run it standalone (debugging only — normally the backend starts it):

```bash
SERVICE_PORT=3061 python3 service-server/app.py
curl -s localhost:3061/health   # {"ok": true}
```

Memory: lingua preloads all language models for best short-text accuracy. Set
`LANGDETECT_LOW_ACCURACY=1` to use trigram-only models if RAM is tight.

## Language detection & inferred user language

`/detect` returns a relative confidence, not an absolute probability (clear English short text
can score ~0.16 while CJK scores ~1.0). So Sharkey does **not** trust a raw threshold. Instead, on
note creation it resolves the stored `note.lang` against the author's **inferred language** — the
majority language over their most recent 100 notes, stored on `user.inferredLang`:

- low-confidence detection of a **trusted** lang (`zh ja en es ru`) → keep it unless very low;
- detection of an **untrusted** lang (everything else — almost always a short-text misdetection)
  → fall back to the user's inferred language unless highly confident;
- **CJK cross-correction**: a note detected as `zh`/`ko` whose author's inferred language is `ja`
  (or vice-versa) is relabeled to the author's language, regardless of confidence.

This corrects ~12% of notes. The rules live once in `service-server/lang_resolve.py` and are
mirrored in `packages/backend/src/core/LanguageDetectionService.ts` (`resolveNoteLang`) — change
both together. Thresholds are tunable via the backend `langDetection` config block:

```yaml
langDetection:
  minConfidence: 0.30             # trusted-lang threshold
  minConfidenceUntrusted: 0.85    # everything else (skeptical)
  trustedLangs: ['zh', 'ja', 'en', 'es', 'ru']
  cjkCrossCorrect: true
  minNotesForInferred: 5          # min classified notes before a user gets an inferred lang
```

`user.inferredLang` is refreshed three ways: after each post (best-effort), nightly for active
users (`rebuildUserInferredLangs` system job), and via the backfill below.

### Backfill

`note.lang` is filled for existing rows by `backfill_lang.py` (keyset scan + lingua fork pool).
`backfill_user_lang.py` then derives the per-user inferred language and can optionally re-resolve
historical notes:

```bash
# env: PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
# Phase 1 — user.inferredLang for ALL users (local + remote). Fast, pure SQL (no detection):
python3 service-server/backfill_user_lang.py

# Phase 2 — OPTIONAL/HEAVY: re-resolve note.lang for old notes using the same spec (re-runs
# lingua to recover confidence; cost ~= backfill_lang.py). Run after phase 1:
python3 service-server/backfill_user_lang.py --annotate-notes --workers 8
```

Both phases are keyset-paginated, checkpointed (`.backfill_user_lang.checkpoint[.notes]`) and
SIGTERM-safe, so they resume where they left off. `--restart` ignores the checkpoint.

## Logs

The process's stdout/stderr are piped into the Sharkey logger (sub-logger `service-server`), so
they appear in `pm2 logs sharkey` and rotate via pm2-logrotate.

---

## CSAM filter (no GPU)

> **Legal:** once you have actual knowledge of CSAM you are (US, 18 U.S.C. §2258A) required to
> report to the **NCMEC CyberTipline** and preserve evidence (~90 days), and must not keep it
> accessible. This system detects/quarantines/preserves/alerts — **filing the report is your
> operational step.**

### Cloudflare CSAM Scanning Tool (primary known-CSAM net)
The instance is behind Cloudflare, so enable the built-in tool — it hash-matches images served
through Cloudflare against NCMEC's database and can auto-notify: Cloudflare dashboard → your zone
→ **Caching → CSAM Scanning Tool**, complete the NCMEC reporting details and enable.

### In-Sharkey MD5 denylist (re-upload net)
At upload (async), Sharkey matches each image's MD5 against an admin-controlled denylist
(`csam_denylist`). On a match the file is **quarantined** (de-served with HTTP 451, not deleted —
evidence preserved), an urgent abuse report is raised, and it is **held for review** (no
auto-suspend). Enable with `enableCsamFilter = true`. Admin API:

- `admin/csam/add-denylist` `{ hashType: 'md5', hashValue, memo? }`
- `admin/csam/list-denylist`, `admin/csam/delete-denylist`
- `admin/csam/list-quarantine` `{ status? }`
- `admin/csam/resolve-quarantine` `{ id, action: 'confirm' | 'dismiss' }`

> Limitation: the MD5 denylist only catches *re-uploads of already-flagged images*. Novel material
> relies on the Cloudflare layer above.

## Daily digest emails
Two repeatable jobs (09:00 daily) email `moderationReportEmail` via the configured Mailgun: a
**spam** digest (counts + per-post note/image links) and a **csam** digest (counts + internal
review links only — never media). Empty days are skipped unless `moderationReportEmailSkipIfEmpty
= false`.
