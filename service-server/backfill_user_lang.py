#!/usr/bin/env python3
# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# Backfill of user."inferredLang" (and, optionally, re-annotation of note.lang) using
# the SAME resolution spec as the live note path. The resolution rules live once in
# service-server/lang_resolve.py and are mirrored in
# packages/backend/src/core/LanguageDetectionService.ts — keep all three in sync.
#
# Phase 1 (default): user inferred language for ALL users (local + remote).
#   - For each user, the majority `lang` among their most recent 100 classified notes,
#     requiring at least --min-notes of them, becomes user."inferredLang".
#   - Pure SQL via a LATERAL that uses the (userId, id) index and reads <=100 rows/user.
#   - Keyset paginated over user.id, checkpointed and resumable. note.lang must already be
#     populated (service-server/backfill_lang.py) — this phase does no detection.
#
# Phase 2 (--annotate-notes, HEAVY/optional): re-resolve note.lang for historical notes.
#   - Re-runs lingua per note to recover confidence (not stored), then applies
#     resolve_note_lang() against the author's inferred language and writes note.lang +
#     note.langConfidence. Cost is comparable to backfill_lang.py (a full detection pass).
#   - Run AFTER phase 1 so inferred languages exist. Separate checkpoint file.
#
# Connection comes from libpq env vars (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD).

import argparse
import multiprocessing as mp
import os
import signal
import time

import psycopg2
from psycopg2.extras import execute_values

from lang_resolve import (
    DEFAULT_MIN_CONFIDENCE,
    DEFAULT_MIN_CONFIDENCE_UNTRUSTED,
    DEFAULT_MIN_NOTES_FOR_INFERRED,
    DEFAULT_TRUSTED_LANGS,
    INFERRED_LANG_WINDOW,
    resolve_note_lang,
)

MAX_SAMPLE_LENGTH = 2000  # match LanguageDetectionService.ts

_detector = None


def build_detector(low_accuracy):
    """Build the lingua detector exactly like service-server/app.py / backfill_lang.py."""
    global _detector
    from lingua import LanguageDetectorBuilder
    builder = LanguageDetectorBuilder.from_all_languages()
    if low_accuracy:
        builder = builder.with_low_accuracy_mode()
    _detector = builder.with_preloaded_language_models().build()


def detect_one(text):
    """Return (iso_639_1 lowercase <=16, confidence) or (None, None) — mirrors /detect."""
    if not text:
        return (None, None)
    sample = text.strip()
    if not sample:
        return (None, None)
    if len(sample) > MAX_SAMPLE_LENGTH:
        sample = sample[:MAX_SAMPLE_LENGTH]
    language = _detector.detect_language_of(sample)
    if language is None:
        return (None, None)
    iso = language.iso_code_639_1.name.lower()[:16]
    conf = _detector.compute_language_confidence(sample, language)
    return (iso, conf)


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "mk2"),
        user=os.environ.get("PGUSER", "calckey"),
        password=os.environ.get("PGPASSWORD", ""),
    )


def read_checkpoint(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def write_checkpoint(path, last_id):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(last_id)
    os.replace(tmp, path)


def make_stopper():
    stopping = {"flag": False}

    def handle(signum, frame):
        stopping["flag"] = True
        print("[backfill] signal received; finishing current batch then stopping…", flush=True)

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)
    return stopping


# ---------------------------------------------------------------------------
# Phase 1: user inferred language
# ---------------------------------------------------------------------------

# Majority lang over each batch user's most recent INFERRED_LANG_WINDOW classified notes.
# The LATERAL's inner LIMIT keeps it on the (userId, id) index — <=100 rows read per user.
USER_LANG_SQL = """
WITH batch AS (
  SELECT id FROM "user" WHERE id > %(last)s ORDER BY id LIMIT %(batch)s
)
SELECT b.id AS uid, m.lang AS lang, COALESCE(m.cnt, 0) AS cnt
FROM batch b
LEFT JOIN LATERAL (
  SELECT lang, COUNT(*) AS cnt
  FROM (
    SELECT lang FROM note
    WHERE "userId" = b.id AND lang IS NOT NULL
    ORDER BY id DESC LIMIT {window}
  ) r
  GROUP BY lang
  ORDER BY cnt DESC, lang
  LIMIT 1
) m ON true
ORDER BY b.id
""".format(window=INFERRED_LANG_WINDOW)

USER_UPDATE_SQL = (
    'UPDATE "user" u SET "inferredLang" = d.lang FROM (VALUES %s) AS d(id, lang) '
    'WHERE u.id = d.id AND u."inferredLang" IS DISTINCT FROM d.lang'
)


def run_user_lang(args):
    checkpoint = args.checkpoint
    last_id = "" if args.restart else read_checkpoint(checkpoint)
    conn = connect()
    conn.autocommit = False
    stopping = make_stopper()
    seen = updated = 0
    start = last_report = time.monotonic()
    print(f"[user-lang] starting (min_notes={args.min_notes}) from id>{last_id!r}", flush=True)
    try:
        while True:
            cur = conn.cursor()
            cur.execute(USER_LANG_SQL, {"last": last_id, "batch": args.batch})
            rows = cur.fetchall()
            cur.close()
            if not rows:
                print("[user-lang] no more users — done.", flush=True)
                break

            pairs = [(uid, lang) for (uid, lang, cnt) in rows if lang is not None and cnt >= args.min_notes]
            if pairs:
                wcur = conn.cursor()
                execute_values(wcur, USER_UPDATE_SQL, pairs)
                updated += wcur.rowcount
                wcur.close()
            conn.commit()

            seen += len(rows)
            last_id = rows[-1][0]
            write_checkpoint(checkpoint, last_id)

            now = time.monotonic()
            if now - last_report >= 5.0:
                rate = seen / (now - start) if now > start else 0
                print(f"[user-lang] seen={seen:,} updated={updated:,} rate={rate:,.0f}/s last_id={last_id}", flush=True)
                last_report = now
            if stopping["flag"]:
                print("[user-lang] stopped by signal; checkpoint saved.", flush=True)
                break
            if args.sleep:
                time.sleep(args.sleep)
    finally:
        conn.close()
        print(f"[user-lang] finished: seen={seen:,} updated={updated:,} in {(time.monotonic()-start)/60:.1f} min (last_id={last_id})", flush=True)


# ---------------------------------------------------------------------------
# Phase 2: re-annotate note.lang (optional, heavy)
# ---------------------------------------------------------------------------

NOTE_SELECT_SQL = (
    'SELECT n.id, n.text, u."inferredLang" '
    'FROM note n JOIN "user" u ON u.id = n."userId" '
    'WHERE n.id > %s AND n.text IS NOT NULL AND n.text <> \'\' '
    'ORDER BY n.id LIMIT %s'
)
NOTE_UPDATE_SQL = (
    'UPDATE note n SET lang = d.lang '
    'FROM (VALUES %s) AS d(id, lang) WHERE n.id = d.id'
)


def run_annotate_notes(args):
    checkpoint = args.checkpoint + ".notes"
    last_id = "" if args.restart else read_checkpoint(checkpoint)
    trusted = DEFAULT_TRUSTED_LANGS
    print(f"[annotate] building lingua detector (low_accuracy={args.low_accuracy})…", flush=True)
    build_detector(args.low_accuracy)
    pool = mp.Pool(processes=args.workers)
    conn = connect()
    conn.autocommit = False
    stopping = make_stopper()
    seen = updated = 0
    start = last_report = time.monotonic()
    try:
        while True:
            cur = conn.cursor()
            cur.execute(NOTE_SELECT_SQL, (last_id, args.batch))
            rows = cur.fetchall()
            cur.close()
            if not rows:
                print("[annotate] no more notes — done.", flush=True)
                break

            ids = [r[0] for r in rows]
            texts = [r[1] for r in rows]
            inferred = [r[2] for r in rows]
            chunk = max(1, len(texts) // (args.workers * 4))
            detected = pool.map(detect_one, texts, chunksize=chunk)

            pairs = []
            for nid, (raw, conf), uinf in zip(ids, detected, inferred):
                lang = resolve_note_lang(
                    raw, conf, uinf,
                    trusted_langs=trusted,
                    min_confidence=args.min_confidence,
                    min_confidence_untrusted=args.min_confidence_untrusted,
                    cjk_cross_correct=not args.no_cjk,
                )
                pairs.append((nid, lang))
            if pairs:
                wcur = conn.cursor()
                execute_values(wcur, NOTE_UPDATE_SQL, pairs)
                updated += wcur.rowcount
                wcur.close()
            conn.commit()

            seen += len(rows)
            last_id = ids[-1]
            write_checkpoint(checkpoint, last_id)

            now = time.monotonic()
            if now - last_report >= 5.0:
                rate = seen / (now - start) if now > start else 0
                print(f"[annotate] seen={seen:,} updated={updated:,} rate={rate:,.0f}/s last_id={last_id}", flush=True)
                last_report = now
            if stopping["flag"]:
                print("[annotate] stopped by signal; checkpoint saved.", flush=True)
                break
            if args.sleep:
                time.sleep(args.sleep)
    finally:
        pool.close()
        pool.join()
        conn.close()
        print(f"[annotate] finished: seen={seen:,} updated={updated:,} in {(time.monotonic()-start)/60:.1f} min (last_id={last_id})", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Backfill user.inferredLang (and optionally re-annotate note.lang)")
    ap.add_argument("--annotate-notes", action="store_true", help="PHASE 2: re-resolve note.lang (heavy; re-runs lingua)")
    ap.add_argument("--batch", type=int, default=5000, help="rows fetched/updated per round")
    ap.add_argument("--workers", type=int, default=8, help="detection workers (phase 2 only)")
    ap.add_argument("--min-notes", type=int, default=DEFAULT_MIN_NOTES_FOR_INFERRED, help="min classified notes to infer a user language")
    ap.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    ap.add_argument("--min-confidence-untrusted", type=float, default=DEFAULT_MIN_CONFIDENCE_UNTRUSTED)
    ap.add_argument("--no-cjk", action="store_true", help="disable the CJK cross-correction (phase 2)")
    ap.add_argument("--sleep", type=float, default=0.0, help="seconds to sleep between batches (DB courtesy)")
    ap.add_argument("--low-accuracy", action="store_true", help="lingua trigram-only mode (phase 2)")
    ap.add_argument("--checkpoint", default=os.path.join(os.path.dirname(__file__), ".backfill_user_lang.checkpoint"))
    ap.add_argument("--restart", action="store_true", help="ignore checkpoint and start from the beginning")
    args = ap.parse_args()

    if args.annotate_notes:
        run_annotate_notes(args)
    else:
        run_user_lang(args)


if __name__ == "__main__":
    main()
