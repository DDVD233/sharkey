#!/bin/bash
# Sample random notes from the Sharkey DB and run the spam classifier over them.
#
# Usage:  ./sample-and-eval.sh [tablesample_pct] [limit]   (e.g. ./sample-and-eval.sh 0.02 12000)
#
# DB creds and the classifier URL/key are read from <repo>/.config/default.yml.
# TABLESAMPLE SYSTEM is used for fast random sampling — ORDER BY random() would scan all
# ~90M rows.
set -euo pipefail

PCT="${1:-0.02}"
LIMIT="${2:-12000}"
SAMPLE_FILE="${SAMPLE_FILE:-/tmp/note_sample.jsonl}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/../../.config/default.yml}"

# Pull DB creds from default.yml.
eval "$(python3 - "$CONFIG_FILE" <<'PY'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))["db"]
print(f'export PGHOST={c["host"]} PGPORT={c["port"]} PGUSER={c["user"]} PGDATABASE={c["db"]}')
print(f'export PGPASSWORD={c["pass"]!r}')
PY
)"

echo "sampling up to $LIMIT notes (TABLESAMPLE SYSTEM ($PCT)) from $PGDATABASE ..."
psql -tA -c "
SELECT json_build_object('id', id, 'h', \"userHost\", 't', left(text, 4000))
FROM note TABLESAMPLE SYSTEM ($PCT)
WHERE text IS NOT NULL AND text <> ''
LIMIT $LIMIT;
" > "$SAMPLE_FILE"
echo "sampled $(wc -l < "$SAMPLE_FILE") notes -> $SAMPLE_FILE"

SAMPLE_FILE="$SAMPLE_FILE" CONFIG_FILE="$CONFIG_FILE" python3 "$SCRIPT_DIR/eval_spam.py"
