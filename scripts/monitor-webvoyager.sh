#!/bin/bash
# Monitor the full WebVoyager 590-task benchmark run
# Usage: watch -n 30 ./scripts/monitor-webvoyager.sh

DIR="agent-results/webvoyager-full-590"
completed=0; passed=0; failed=0; total_cost=0; total_time=0

for dir in "$DIR"/wv-*/; do
  s="${dir}baseline-summary.json"
  [ -f "$s" ] || continue
  completed=$((completed+1))

  result=$(node -e "
    const j=JSON.parse(require('fs').readFileSync('$s','utf8'));
    const m=j.runs?.[0]?.metrics;
    console.log(m?.passed ? 'P' : 'F', m?.durationMs||0, m?.estimatedCostUsd||0);
  " 2>/dev/null)

  status=$(echo "$result" | cut -d' ' -f1)
  dur=$(echo "$result" | cut -d' ' -f2)
  cost=$(echo "$result" | cut -d' ' -f3)

  [ "$status" = "P" ] && passed=$((passed+1)) || failed=$((failed+1))
done

active=$(ps aux | grep "dist/cli.js" | grep -v grep | wc -l | tr -d ' ')
pct=$( [ $completed -gt 0 ] && echo "scale=1; $passed * 100 / $completed" | bc || echo "0")

echo "═══════════════════════════════════════"
echo " WebVoyager Full Benchmark — Gen 15"
echo "═══════════════════════════════════════"
echo " Progress:  ${completed}/590 ($(echo "scale=1; $completed * 100 / 590" | bc)%)"
echo " Pass rate: ${passed}/${completed} (${pct}%)"
echo " Failed:    ${failed}"
echo " Active:    ${active} CLI procs"
echo " ETA:       ~$(echo "scale=0; (590 - $completed) * 45 / $active / 60" | bc 2>/dev/null || echo '?')min"
echo "═══════════════════════════════════════"
