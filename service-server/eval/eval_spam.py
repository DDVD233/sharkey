#!/usr/bin/env python3
"""
Dry-run evaluation for the Sharkey spam classifier.

Reads a JSONL sample of notes (one object per line: {"id","h","t"} where h=userHost,
t=text), classifies each via the running classifier using N concurrent workers, and
reports the flag rate plus latency/throughput. Positives are written to a TSV for review.

Config: classifier URL + key are read from .config/default.yml
(`spamFilterServerUrl`, `spamFilterApiKey`); env vars override.

Env:
  CLASSIFIER_URL / CLASSIFIER_KEY   override config
  CONFIG_FILE      path to default.yml (default: <repo>/.config/default.yml)
  SAMPLE_FILE      input JSONL   (default: /tmp/note_sample.jsonl)
  OUT_FILE         positives TSV (default: /tmp/spam_positives.tsv)
  SUMMARY_FILE     summary text  (default: /tmp/spam_eval_summary.txt)
  WORKERS          concurrency   (default: 32)
"""
import json, os, sys, time, pathlib, urllib.request, concurrent.futures

cfg_path = os.environ.get("CONFIG_FILE") or str(pathlib.Path(__file__).resolve().parents[2] / ".config" / "default.yml")
cfg = {}
try:
    import yaml
    with open(cfg_path) as f:
        cfg = yaml.safe_load(f) or {}
except Exception as e:
    print(f"warning: could not read config {cfg_path}: {e}", file=sys.stderr)

URL = os.environ.get("CLASSIFIER_URL") or ((cfg.get("spamFilterServerUrl") or "").rstrip("/") + "/classify")
KEY = os.environ.get("CLASSIFIER_KEY") or (cfg.get("spamFilterApiKey") or "")
SKIP_HOSTS = set(cfg.get("spamFilterSkipHosts") or [])
INFILE = os.environ.get("SAMPLE_FILE", "/tmp/note_sample.jsonl")
OUTFILE = os.environ.get("OUT_FILE", "/tmp/spam_positives.tsv")
SUMMARYFILE = os.environ.get("SUMMARY_FILE", "/tmp/spam_eval_summary.txt")
WORKERS = int(os.environ.get("WORKERS", "32"))

if not URL.startswith("http") or not KEY:
    sys.exit(f"missing classifier URL/key (URL={URL!r}); set in {cfg_path} or via env")

notes = []
whitelisted = 0
for line in open(INFILE):
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        continue
    # Skip large well-moderated servers entirely (matches production behaviour).
    if o.get("h") in SKIP_HOSTS:
        whitelisted += 1
        continue
    notes.append(o)

def classify(o):
    body = json.dumps({"text": o.get("t") or ""}).encode()
    req = urllib.request.Request(
        URL, data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.loads(r.read())
        return (o, d.get("label"), float(d.get("confidence", 0)), None, time.monotonic() - t0)
    except Exception as e:
        return (o, None, 0.0, str(e)[:120], time.monotonic() - t0)

total = len(notes)
flagged = []
errors = 0
done = 0
latencies = []
print(f"scanning {total} notes with {WORKERS} workers -> {URL}", file=sys.stderr)
wall0 = time.monotonic()
with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
    for o, label, conf, err, lat in ex.map(classify, notes):
        done += 1
        if err:
            errors += 1
        else:
            latencies.append(lat)
            if label and label != "ham":
                flagged.append((conf, o.get("h"), o.get("id"), (o.get("t") or "").replace("\n", " ").replace("\t", " ")[:300]))
        if done % 1000 == 0:
            el = time.monotonic() - wall0
            print(f"  {done}/{total}  flagged={len(flagged)}  err={errors}  {done/el:.1f}/s", file=sys.stderr)
wall = time.monotonic() - wall0

flagged.sort(reverse=True)
with open(OUTFILE, "w") as f:
    f.write("confidence\thost\tid\ttext\n")
    for conf, h, i, t in flagged:
        f.write(f"{conf:.4f}\t{h}\t{i}\t{t}\n")

def pct(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]

scanned = total - errors
rate = 100 * len(flagged) / scanned if scanned else 0
remote_flags = sum(1 for x in flagged if x[1])
local_flags = len(flagged) - remote_flags
mean_lat = (sum(latencies) / len(latencies)) if latencies else 0
summary = (
    "=== RESULTS ===\n"
    f"whitelisted_skipped: {whitelisted} (hosts: {sorted(SKIP_HOSTS)})\n"
    f"sampled: {total}  scanned_ok: {scanned}  errors: {errors}\n"
    f"flagged: {len(flagged)}  ({local_flags} local, {remote_flags} remote)\n"
    f"flag_rate: {rate:.2f}%  (target < 1%)\n"
    "--- performance ---\n"
    f"workers: {WORKERS}\n"
    f"wall_clock: {wall:.1f}s\n"
    f"throughput: {scanned/wall:.1f} samples/s\n"
    f"latency per request: mean {mean_lat*1000:.0f}ms  p50 {pct(latencies,50)*1000:.0f}ms  p95 {pct(latencies,95)*1000:.0f}ms\n"
    f"positives -> {OUTFILE}\n"
)
with open(SUMMARYFILE, "w") as f:
    f.write(summary)
print("\n" + summary)
