#!/usr/bin/env bash
# Benchmark runner: executes the same task N times, captures metrics per run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CASES="$SCRIPT_DIR/github-search.json"
RUNS="${1:-3}"
MODEL="${2:-gpt-4o}"
RESULTS_DIR="$SCRIPT_DIR/results"

# Load .env
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; source "$PROJECT_DIR/.env"; set +a
fi

mkdir -p "$RESULTS_DIR"

echo "=== Agent Browser Driver Benchmark ==="
echo "Model:    $MODEL"
echo "Runs:     $RUNS"
echo "Task:     GitHub top repos search"
echo "Features: --block-analytics (resource blocking enabled)"
echo ""

for i in $(seq 1 "$RUNS"); do
  SINK="$RESULTS_DIR/run-$i"
  mkdir -p "$SINK"
  echo "--- Run $i/$RUNS ---"
  START=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')

  node "$PROJECT_DIR/dist/cli.js" run \
    --cases "$CASES" \
    --model "$MODEL" \
    --provider openai \
    --sink "$SINK" \
    --block-analytics \
    --max-turns 15 \
    --debug \
    2>&1 | tee "$SINK/output.log"

  END=$(date +%s%3N 2>/dev/null || python3 -c 'import time; print(int(time.time()*1000))')
  ELAPSED=$(( END - START ))
  echo ""
  echo "Run $i wall time: ${ELAPSED}ms"
  echo "---"
  echo ""
done

# Summarize
echo "=== Summary ==="
for i in $(seq 1 "$RUNS"); do
  REPORT="$RESULTS_DIR/run-$i/report.json"
  if [ -f "$REPORT" ]; then
    echo "Run $i:"
    python3 -c "
import json, sys
with open('$REPORT') as f:
    data = json.load(f)
s = data.get('summary', {})
results = data.get('results', [])
print(f'  Passed: {s.get(\"passed\",\"?\")}/{s.get(\"total\",\"?\")}')
print(f'  Avg turns: {s.get(\"avgTurns\",\"?\")}')
print(f'  Avg tokens: {s.get(\"avgTokens\",\"?\")}')
print(f'  Duration: {s.get(\"totalDurationMs\",\"?\")}ms')
for r in results:
    print(f'  Result: {r.get(\"verdict\",\"no verdict\")[:100]}')
" 2>/dev/null || echo "  (could not parse report)"
  fi
done
