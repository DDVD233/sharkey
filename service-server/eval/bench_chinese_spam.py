#!/usr/bin/env python3
# SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
# SPDX-License-Identifier: AGPL-3.0-only
"""
Benchmark the Sharkey spam classifier against a labeled CSV dataset
(columns: label,text  where 1=spam, 0=ham).

Posts each row to the local service-server /classify (no inbound auth),
passing the live vLLM url/key/model through exactly like SpamFilterService does.

Computes a confusion matrix (raw endpoint label AND production-thresholded),
precision/recall/F1/accuracy, false-positive rate, latency, and dumps the
misclassified rows (false negatives = misses, false positives) to TSV.

Env:
  CLASSIFY_URL   default http://127.0.0.1:3061/classify
  VLLM_URL / VLLM_KEY / VLLM_MODEL   vLLM passthrough (required)
  SPAM_THRESHOLD confidence cutoff for production-style flagging (default 0.9)
  WORKERS        concurrency (default 24)
  IN_CSV         input csv (default eval/data/test.csv)
  OUT_DIR        where to write *_misses.tsv etc (default eval/out)
"""
import csv, json, os, sys, time, pathlib, urllib.request, concurrent.futures

CLASSIFY_URL = os.environ.get("CLASSIFY_URL", "http://127.0.0.1:3061/classify")
VLLM_URL = os.environ.get("VLLM_URL", "")
VLLM_KEY = os.environ.get("VLLM_KEY", "")
VLLM_MODEL = os.environ.get("VLLM_MODEL", "")
THRESHOLD = float(os.environ.get("SPAM_THRESHOLD", "0.9"))
WORKERS = int(os.environ.get("WORKERS", "24"))
IN_CSV = os.environ.get("IN_CSV", "eval/data/test.csv")
OUT_DIR = pathlib.Path(os.environ.get("OUT_DIR", "eval/out"))

if not VLLM_URL or not VLLM_MODEL:
    sys.exit("set VLLM_URL / VLLM_KEY / VLLM_MODEL")
OUT_DIR.mkdir(parents=True, exist_ok=True)

rows = []
for r in csv.DictReader(open(IN_CSV, newline="")):
    t = (r.get("text") or "").strip()
    if not t:
        continue
    rows.append({"gold": 1 if r.get("label") == "1" else 0, "text": t})

def classify(o):
    body = json.dumps({
        "text": o["text"],
        "vllm_url": VLLM_URL, "vllm_key": VLLM_KEY, "model": VLLM_MODEL,
    }).encode()
    req = urllib.request.Request(CLASSIFY_URL, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            d = json.loads(resp.read())
        return o, d.get("label"), float(d.get("confidence", 0)), None, time.monotonic() - t0
    except Exception as e:
        return o, None, 0.0, str(e)[:140], time.monotonic() - t0

total = len(rows)
print(f"benchmarking {total} rows from {IN_CSV} with {WORKERS} workers -> {CLASSIFY_URL}", file=sys.stderr)

results = []
errors = 0
lat = []
done = 0
wall0 = time.monotonic()
with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    for o, label, conf, err, dt in ex.map(classify, rows):
        done += 1
        if err:
            errors += 1
        else:
            lat.append(dt)
            results.append((o, label, conf))
        if done % 250 == 0:
            el = time.monotonic() - wall0
            print(f"  {done}/{total}  err={errors}  {done/el:.1f}/s", file=sys.stderr)
wall = time.monotonic() - wall0

def confusion(predicate):
    tp = fp = fn = tn = 0
    fns, fps = [], []
    for o, label, conf in results:
        pred = 1 if predicate(label, conf) else 0
        if o["gold"] == 1 and pred == 1: tp += 1
        elif o["gold"] == 1 and pred == 0: fn += 1; fns.append((conf, label, o["text"]))
        elif o["gold"] == 0 and pred == 1: fp += 1; fps.append((conf, label, o["text"]))
        else: tn += 1
    return tp, fp, fn, tn, fns, fps

def metrics(tp, fp, fn, tn):
    n = tp + fp + fn + tn
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    acc = (tp + tn) / n if n else 0.0
    fpr = fp / (fp + tn) if fp + tn else 0.0
    return prec, rec, f1, acc, fpr

def pct(xs, p):
    if not xs: return 0.0
    s = sorted(xs); return s[min(len(s) - 1, int(p / 100 * len(s)))]

# Two prediction rules:
raw = confusion(lambda label, conf: label == "spam")
thr = confusion(lambda label, conf: label == "spam" and conf >= THRESHOLD)

split = pathlib.Path(IN_CSV).stem
def dump(name, items):
    path = OUT_DIR / f"{split}_{name}.tsv"
    items.sort(reverse=True)
    with open(path, "w") as f:
        f.write("confidence\tpred_label\ttext\n")
        for conf, label, text in items:
            f.write(f"{conf:.4f}\t{label}\t{text[:400].replace(chr(9),' ').replace(chr(10),' ')}\n")
    return path

# Misses = false negatives (gold spam, predicted ham). Dump both raw and thresholded views.
miss_raw = dump("misses_raw", list(raw[4]))
fp_raw = dump("falsepos_raw", list(raw[5]))
miss_thr = dump("misses_thresholded", list(thr[4]))

lines = []
lines.append("=== Chinese spam benchmark ===")
lines.append(f"dataset: {IN_CSV}   model: {VLLM_MODEL}")
lines.append(f"rows: {total}  scanned_ok: {len(results)}  errors: {errors}")
gold_spam = sum(1 for o, _, _ in results if o["gold"] == 1)
lines.append(f"gold: spam={gold_spam}  ham={len(results)-gold_spam}")
lines.append("")
for name, (tp, fp, fn, tn, fns, fps) in [("RAW label (spam vs ham)", raw),
                                          (f"PRODUCTION (spam & conf>={THRESHOLD})", thr)]:
    prec, rec, f1, acc, fpr = metrics(tp, fp, fn, tn)
    lines.append(f"--- {name} ---")
    lines.append(f"  TP={tp} FP={fp} FN={fn} TN={tn}")
    lines.append(f"  recall(spam caught)={rec*100:.2f}%  precision={prec*100:.2f}%  F1={f1*100:.2f}%")
    lines.append(f"  accuracy={acc*100:.2f}%  false-positive-rate(ham flagged)={fpr*100:.2f}%")
    lines.append("")
lines.append("--- performance ---")
lines.append(f"  workers={WORKERS}  wall={wall:.1f}s  throughput={len(results)/wall:.1f}/s" if wall else "")
mean = sum(lat)/len(lat) if lat else 0
lines.append(f"  latency mean {mean*1000:.0f}ms  p50 {pct(lat,50)*1000:.0f}ms  p95 {pct(lat,95)*1000:.0f}ms")
lines.append("")
lines.append("--- outputs ---")
lines.append(f"  misses (FN, raw):         {miss_raw}  ({len(raw[4])} rows)")
lines.append(f"  misses (FN, thresholded): {miss_thr}  ({len(thr[4])} rows)")
lines.append(f"  false positives (raw):    {fp_raw}  ({len(raw[5])} rows)")

summary = "\n".join(lines)
(OUT_DIR / f"{split}_summary.txt").write_text(summary + "\n")
print("\n" + summary)
