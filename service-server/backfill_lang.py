#!/usr/bin/env python3
# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
#
# One-off backfill of note.lang for existing notes, using the SAME lingua
# configuration as the live /detect service (service-server/app.py) so results
# match what new notes get.
#
# Strategy:
#   - Single forward pass over `note` by primary key (keyset pagination), which
#     uses the PK index and never re-scans. Only rows with text and lang IS NULL
#     are processed, so the job is idempotent and resumable.
#   - Language detection (CPU-bound) is parallelised across a fork pool. The
#     lingua detector is built ONCE in the parent before forking, so the ~GB of
#     preloaded models are shared copy-on-write instead of duplicated per worker.
#   - Updates are written in batches via a single UPDATE ... FROM (VALUES ...).
#   - A checkpoint file records the last processed id so an interrupted run can
#     resume where it left off.
#
# Connection comes from standard libpq env vars (PGHOST/PGPORT/PGDATABASE/
# PGUSER/PGPASSWORD); pass them in the environment when launching.

import argparse
import multiprocessing as mp
import os
import signal
import sys
import time

import psycopg2
from psycopg2.extras import execute_values

# Match LanguageDetectionService.ts: only the head of the text is needed.
MAX_SAMPLE_LENGTH = 2000

_detector = None


def build_detector(low_accuracy: bool):
    """Build the lingua detector exactly like service-server/app.py."""
    global _detector
    from lingua import LanguageDetectorBuilder
    builder = LanguageDetectorBuilder.from_all_languages()
    if low_accuracy:
        builder = builder.with_low_accuracy_mode()
    _detector = builder.with_preloaded_language_models().build()


def detect_one(text):
    """Return an ISO 639-1 code (lowercase, <=16 chars) or None — mirrors /detect."""
    if not text:
        return None
    sample = text.strip()
    if not sample:
        return None
    if len(sample) > MAX_SAMPLE_LENGTH:
        sample = sample[:MAX_SAMPLE_LENGTH]
    language = _detector.detect_language_of(sample)
    if language is None:
        return None
    return language.iso_code_639_1.name.lower()[:16]


def connect():
    # Uses libpq env vars; sslmode/etc. honoured automatically.
    conn = psycopg2.connect(
        host=os.environ.get("PGHOST", "localhost"),
        port=os.environ.get("PGPORT", "5432"),
        dbname=os.environ.get("PGDATABASE", "mk2"),
        user=os.environ.get("PGUSER", "calckey"),
        password=os.environ.get("PGPASSWORD", ""),
    )
    return conn


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


def main():
    ap = argparse.ArgumentParser(description="Backfill note.lang via lingua")
    ap.add_argument("--batch", type=int, default=5000, help="rows fetched/updated per round")
    ap.add_argument("--workers", type=int, default=8, help="detection worker processes")
    ap.add_argument("--sleep", type=float, default=0.0, help="seconds to sleep between batches (DB courtesy)")
    ap.add_argument("--limit", type=int, default=0, help="stop after roughly N rows processed (0 = all)")
    ap.add_argument("--checkpoint", default=os.path.join(os.path.dirname(__file__), ".backfill_lang.checkpoint"))
    ap.add_argument("--restart", action="store_true", help="ignore checkpoint and start from the beginning")
    ap.add_argument("--low-accuracy", action="store_true", help="lingua trigram-only mode (faster, less RAM)")
    ap.add_argument("--est-total", type=int, default=40_000_000, help="estimate of rows needing backfill, for ETA")
    args = ap.parse_args()

    last_id = "" if args.restart else read_checkpoint(args.checkpoint)

    print(f"[backfill] building lingua detector (low_accuracy={args.low_accuracy})…", flush=True)
    t0 = time.monotonic()
    build_detector(args.low_accuracy)
    print(f"[backfill] detector ready in {time.monotonic()-t0:.1f}s; forking {args.workers} workers", flush=True)

    # Fork AFTER the detector is built so children share its memory copy-on-write.
    pool = mp.Pool(processes=args.workers)

    conn = connect()
    conn.autocommit = False
    read_cur = conn.cursor(name="note_scan")  # server-side cursor not needed; we keyset manually
    read_cur.close()

    select_sql = (
        "SELECT id, text FROM note "
        "WHERE id > %s AND lang IS NULL AND text IS NOT NULL AND text <> '' "
        "ORDER BY id LIMIT %s"
    )
    update_sql = (
        "UPDATE note SET lang = d.lang FROM (VALUES %s) AS d(id, lang) "
        "WHERE note.id = d.id AND note.lang IS NULL"
    )

    seen = 0
    updated = 0
    start = time.monotonic()
    last_report = start

    stopping = {"flag": False}

    def handle_sigterm(signum, frame):
        stopping["flag"] = True
        print("[backfill] signal received; finishing current batch then stopping…", flush=True)

    signal.signal(signal.SIGTERM, handle_sigterm)
    signal.signal(signal.SIGINT, handle_sigterm)

    try:
        while True:
            cur = conn.cursor()
            cur.execute(select_sql, (last_id, args.batch))
            rows = cur.fetchall()
            cur.close()
            if not rows:
                print("[backfill] no more rows — done.", flush=True)
                break

            ids = [r[0] for r in rows]
            texts = [r[1] for r in rows]
            # chunksize keeps IPC overhead low while keeping all workers busy.
            chunk = max(1, len(texts) // (args.workers * 4))
            langs = pool.map(detect_one, texts, chunksize=chunk)

            pairs = [(i, l) for i, l in zip(ids, langs) if l is not None]
            if pairs:
                wcur = conn.cursor()
                execute_values(wcur, update_sql, pairs)
                wcur.close()
            conn.commit()

            seen += len(rows)
            updated += len(pairs)
            last_id = ids[-1]
            write_checkpoint(args.checkpoint, last_id)

            now = time.monotonic()
            if now - last_report >= 5.0:
                rate = seen / (now - start) if now > start else 0
                remaining = max(0, args.est_total - updated)
                eta_h = (remaining / rate / 3600) if rate > 0 else float("inf")
                print(
                    f"[backfill] seen={seen:,} updated={updated:,} "
                    f"rate={rate:,.0f}/s last_id={last_id} ~ETA={eta_h:.1f}h",
                    flush=True,
                )
                last_report = now

            if args.limit and seen >= args.limit:
                print(f"[backfill] reached --limit {args.limit}; stopping.", flush=True)
                break
            if stopping["flag"]:
                print("[backfill] stopped by signal; checkpoint saved.", flush=True)
                break
            if args.sleep:
                time.sleep(args.sleep)
    finally:
        pool.close()
        pool.join()
        conn.close()
        elapsed = time.monotonic() - start
        print(
            f"[backfill] finished: seen={seen:,} updated={updated:,} in {elapsed/60:.1f} min "
            f"(last_id={last_id})",
            flush=True,
        )


if __name__ == "__main__":
    main()
