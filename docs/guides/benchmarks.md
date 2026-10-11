# Benchmarks & Experiments

The current bench harness is the competitive runner: `pnpm bench:compete`
(`scripts/run-competitive.mjs`) executes the corpus in `bench/competitive/tasks/`
against every framework adapter in `bench/competitive/adapters/` and verifies
each run with the task's external oracle. Fixtures are served statically from
`bench/fixtures/`.

```bash
pnpm bench:compete -- --frameworks bad,browser-use --reps 3 \
  --model gemini-2.5-flash --baseline bad --out agent-results/competitive-<label>
```

Latest numbers and the full methodology (corpus, reps, stats, cost
conventions): [docs/bench-2026-10-11-hillclimb-program.md](../bench-2026-10-11-hillclimb-program.md)
and [docs/COMPETITIVE-EVAL.md](../COMPETITIVE-EVAL.md). To add a task, see
[examples/author-a-bench-task.md](../../examples/author-a-bench-task.md).

## Rigor rules

- **≥3 reps** per cell (5 for variance-heavy cells); the runner computes
  Wilson 95% CIs.
- **Same-day, same-machine, same-key controls** — provider weather moves
  cells by 2–3 points. Never compare against numbers from another day.
- **Headless always** — the adapters enforce it.
- `--allow-quick-check` runs prove plumbing only and are never cited.
- Any pass-rate regression gets an isolation rerun on the affected cells
  before a change is kept or dropped.

## Multi-rep validation

```bash
pnpm bench:validate -- \
  --cases <cases.json> \
  --reps 3 --out agent-results/my-validation
```

## Single-task mode comparison

Run the same goal across run modes:

```bash
pnpm baseline:modes -- \
  --goal "Navigate to /partner/coinbase" \
  --url https://ai.tangle.tools \
  --model gemini-2.5-flash --provider google \
  --modes fast-explore
```

## Failure Classification

Generate a ranked failure taxonomy from results:

```bash
pnpm reliability:scorecard -- \
  --root ./agent-results/<run-dir> \
  --out ./agent-results/<run-dir>/reliability-scorecard.json \
  --md ./agent-results/<run-dir>/reliability-scorecard.md
```

## Reliability Trend

Render a trend from accumulated local history:

```bash
pnpm reliability:trend -- \
  --history ./agent-results/local-history.jsonl \
  --out ./agent-results/reliability-trend.json \
  --md ./agent-results/reliability-trend.md
```

## Replay-cache CI

Verified replay reruns browser tasks at ~10–20% of live LLM cost with zero
decide calls. Recipe: [examples/replay-cache-ci.md](../../examples/replay-cache-ci.md).
