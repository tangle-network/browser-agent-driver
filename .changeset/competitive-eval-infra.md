---
'@tangle-network/browser-agent-driver': minor
---

Competitive eval infrastructure — `pnpm bench:compete` for head-to-head comparison against other browser-agent frameworks.

The fourth canonical validation tool alongside `bench:validate`, `ab:experiment`, and `research:pipeline --two-stage` (see `docs/EVAL-RIGOR.md`). Same rigor protocol: ≥3 reps per cell enforced, no single-run claims allowed.

## What ships

- **`scripts/run-competitive.mjs`** + `pnpm bench:compete` — single entry for cross-framework benchmarking. Loads tasks from `bench/competitive/tasks/`, dispatches to adapters in `bench/competitive/adapters/`, runs each (framework × task × rep) cell, computes per-cell stats and cross-framework comparisons, writes `runs.jsonl` + `runs.csv` + `summary.json` + `comparison.md`.

- **`scripts/lib/stats.mjs`** — extracted statistical primitives (mean, stddev, median, quantile, Wilson CI, bootstrap CI on a single sample mean and on the difference of two means, Cohen's d effect size + classifier, Mann-Whitney U two-sided p-value, spread-test verdict implementing CLAUDE.md rule #2). `run-ab-experiment.mjs` refactored to use the lib (no behavior change). 28 deterministic unit tests in `tests/competitive-stats.test.ts`.

- **`bench/competitive/tasks/_schema.json`** — task schema. Required fields: `id`, `name`, `goal`, `oracle`. Oracle types: `text-in-snapshot`, `url-contains`, `json-shape-match`, `selector-state` (degraded form). Each task is runnable by EVERY framework adapter — no framework-specific quirks.

- **`bench/competitive/tasks/form-fill-multi-step.json`** — first task: 19 fields, 3 form steps, ported from `bench/scenarios/cases/local-long-form.json`. Oracle: `text-in-snapshot` looking for "Account Created!".

- **`bench/competitive/adapters/bad.mjs`** — `bad` adapter. Spawns `scripts/run-mode-baseline.mjs`, parses suite report.json, walks events.jsonl to aggregate per-LLM-call counters (`llmCallCount`, `cacheReadInputTokens` — the agent's run-level summary doesn't carry the cache aggregate), runs the external oracle, returns a `CompetitiveRunResult`. The agent's `agentSuccess` is reported alongside but is NOT the verdict — the external oracle is.

- **`bench/competitive/adapters/_oracle.mjs`** — shared oracle evaluator. Every adapter calls `evaluateOracle(oracle, finalState)` so the same task evaluates identically regardless of which framework ran.

- **`bench/competitive/adapters/browser-use.mjs`** + **`bench/competitive/adapters/stagehand.mjs`** — STUB adapters. Detection works (looks for installed packages). `runTask` returns a clean failure record with `errorReason: 'adapter not yet implemented (stub)'`. Implement when the user installs the respective competitor framework — we don't bake heavy Python/Browserbase deps into this repo's `package.json`.

- **`docs/COMPETITIVE-EVAL.md`** — operating manual. How to add tasks, how to add adapters, install steps for browser-use and Stagehand, the full `CompetitiveRunResult` shape, and a "related-but-different tools" section explaining why `millionco/expect` is complementary not competitive.

- **`docs/EVAL-RIGOR.md`** updated to name **four** canonical validation paths (was three).

## Statistics reported per cell

For each (framework × task) cell with N reps:

- Pass rate + Wilson 95% CI on the rate
- Per metric (wall-time, turns, LLM calls, total/input/output/cached tokens, cost): `n / mean / stddev / min / median / p95 / max`
- Cache-hit rate (cached input / total input)

For each (challenger vs baseline) comparison:

- Δ and Δ% per metric
- Bootstrap 95% CI on the difference of means (2000 resamples, seeded for reproducibility)
- Cohen's d effect size + magnitude classifier (trivial / small / medium / large)
- Mann-Whitney U two-sided p-value (normal approximation, valid for n1+n2 ≥ 8)
- Spread-test verdict per metric: `win` / `comparable` / `regression`

## Verified end-to-end

`pnpm bench:compete --frameworks bad --tasks form-fill-multi-step --reps 3` ran cleanly to completion:

| metric | n | mean | stddev | min | median | max |
|---|---:|---:|---:|---:|---:|---:|
| wall-time (s) | 3 | 31.4 | 12.4 | 18.1 | 33.5 | 42.7 |
| turns | 3 | 9.3 | 1.2 | 8 | 10 | 10 |
| LLM calls | 3 | 3.3 | 0.6 | 3 | 3 | 4 |
| total tokens | 3 | 9467 | 1367 | 8248 | 9208 | 10945 |
| cached tokens | 3 | 4437 | 961 | 3328 | 4992 | 4992 |
| cost ($) | 3 | 0.036 | 0.007 | 0.028 | 0.039 | 0.041 |

**Cache-hit rate: 56.3%** — confirms OpenAI prompt caching is working for the planner system prompt across plan + replan + replan calls within each run. Closes the long-standing "verify cache hit on a real run" task.

## Cleanup

- Removed `bench:classify` package.json alias (was an exact duplicate of `reliability:scorecard`). Updated `bench/scenarios/README.md` and `docs/guides/benchmarks.md` to use the canonical name.
- Reorganized `package.json` scripts into logical groups (lifecycle / release / validation harnesses / tier gates / local profiles / baselines / reliability reports / external benches / wallet / standalone) for readability.

## Tests

**930 passing** (was 884, **+46 net new**):
- 28 in `tests/competitive-stats.test.ts` covering mean / stddev / median / quantile / Wilson / bootstrap mean+diff / Cohen d / Mann-Whitney U / spread verdict
- 18 in `tests/competitive-bad-adapter.test.ts` covering detect() and all 4 oracle types (hits, misses, edge cases)

Tier1 deterministic gate: maintained.
