# Benchmarks & Experiments

## Benchmark Tiers

| Tier | Scope | Gate threshold |
|------|-------|----------------|
| Tier 1 | Deterministic local fixtures | 100% required |
| Tier 2 | Authenticated staging flows | Push to 100% |
| Tier 3 | Open web (WebBench-50) | Track separately, no Tier 1/2 regression |

## Local Presets

```bash
pnpm bench:local:smoke    # single fixture, fast iteration
pnpm bench:local:tier1    # CI deterministic gate parity
pnpm bench:local:tier2    # staging gate (needs .auth/ai-tangle-tools.json)
pnpm bench:local:nightly  # lint + build + tier1 + webbench sample + tier2
```

All presets write `reliability-scorecard.json` and append to `./agent-results/local-history.jsonl`.

## Tier 1 Gate

```bash
npm run bench:tier1:gate -- \
  --out ./agent-results/tier1-local \
  --model gpt-5.4 \
  --min-full-pass-rate 1 \
  --min-fast-pass-rate 1 \
  --max-avg-turns 24 \
  --max-avg-duration-ms 120000
```

Exits non-zero on threshold violation or missing artifacts.

## Tier 2 Gate

```bash
npm run bench:tier2:gate -- \
  --out ./agent-results/tier2-staging \
  --model gpt-5.4 \
  --storage-state ./.auth/ai-tangle-tools.json \
  --min-full-pass-rate 1 \
  --min-fast-pass-rate 1
```

## AB Experiments

Spec-driven champion/challenger comparison:

```bash
npm run ab:experiment -- \
  --spec ./bench/scenarios/specs/supervisor-ab-webbench.json \
  --out ./agent-results/ab-exp-webbench
```

Flags:
- `--prompt-file <path>` — shared prompt variant
- `--memory --memory-isolation per-run` — no memory leakage across reps
- `--modes <csv>` — subset of modes
- `--seed <value>` — deterministic case ordering (default `1337`)

AB summaries include raw pass rate, blocker-adjusted clean pass rate, failure-class rollups.

## Research Cycles

Run multiple AB specs as a ranked cycle:

```bash
npm run research:cycle -- \
  --specs spec1.json,spec2.json \
  --out ./agent-results/research-cycle
```

Outputs: `cycle-summary.json`, `cycle-leaderboard.csv`, `cycle-summary.md`.

## Scenario Track

Multi-scenario mode comparison from a case track file:

```bash
npm run baseline:track -- \
  --cases ./bench/scenarios/cases/staging-auth-ai-tangle.json \
  --storage-state ./.auth/ai-tangle-tools.json \
  --model gpt-5.4 \
  --modes fast-explore
```

## Baseline Mode Comparison

Run the same goal across modes:

```bash
npm run baseline:modes -- \
  --goal "Navigate to /partner/coinbase" \
  --url https://ai.tangle.tools \
  --model gpt-5.4 \
  --modes fast-explore
```

## Failure Classification

Generate a ranked failure taxonomy from results:

```bash
npm run bench:classify -- \
  --root ./agent-results/ab-exp-sample \
  --out ./agent-results/ab-exp-sample/reliability-scorecard.json \
  --md ./agent-results/ab-exp-sample/reliability-scorecard.md
```

## Reliability Trend

Render trend from accumulated local history:

```bash
pnpm reliability:trend -- \
  --history ./agent-results/local-history.jsonl \
  --profile tier1 \
  --out ./agent-results/reliability-trend.json \
  --md ./agent-results/reliability-trend.md
```

## Benchmark UI

When `../abd-app` is present, benchmark runs auto-import into its D1/R2 store.

```bash
cd ../abd-app && npm run dev && npm run dev:api
# open http://localhost:5173/benchmarks
```

Disable with `ABD_BENCHMARK_SYNC=0`. Manual import:

```bash
cd ../abd-app/worker
npm run bench:import-local -- --path ../../browser-agent-driver/agent-results/<run-dir>
```

## Promotion Rules

- No pass-rate regression on Tier 1/2
- Positive bootstrap CI lower bound on targeted experiments
- No artifact-quality regression
- One variable per cycle
