---
name: bench
description: Run WebbBench-50, diff against baseline, surface regressions
---

Run WebbBench-50 and compare results against the last known baseline.

## Process

1. Determine profile and parameters:
   - Default: `--benchmark-profile webbench-stealth --model gpt-5.4 --modes fast-explore --concurrency 3`
   - If the user specifies a profile, model, or concurrency, override the defaults
   - Case file: `bench/scenarios/cases/webbench-full50-max20-timeout180.json`

2. Run the benchmark:
   ```bash
   node scripts/run-scenario-track.mjs \
     --cases bench/scenarios/cases/webbench-full50-max20-timeout180.json \
     --benchmark-profile <profile> \
     --model <model> \
     --modes <modes> \
     --concurrency <concurrency>
   ```

3. Parse results from the track summary output. Extract:
   - Total pass/fail/skip counts
   - Per-case pass/fail with failure reasons
   - Median duration and token usage

4. Compare against baseline:
   - **Current baseline: 48/50 (96%)**
   - Known failures: Cambridge (anti-bot), AliExpress (timeout)
   - Flag any NEW failures not in the known-failures list as **regressions**
   - Flag any previously-failing cases that now PASS as **improvements**

5. Output a summary table:
   ```
   | Case | Status | Duration | Notes |
   |------|--------|----------|-------|
   ```

6. Final verdict:
   - **NO REGRESSION** — pass rate >= baseline, no new failures
   - **REGRESSION** — new failures detected, list them with failure reasons
   - **IMPROVEMENT** — baseline exceeded, highlight newly passing cases

## Rules

- Never skip the comparison step — raw numbers without context are useless
- If the run fails to start (missing API keys, port conflicts), diagnose immediately instead of retrying
- Anti-bot and unreachable failures are tracked separately from agent reliability failures
- One clean run is sufficient for triage; use `--concurrency 1` for promotion-grade studies
