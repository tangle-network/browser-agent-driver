# Competitive Benchmark — bad vs the field

**Status:** scaffold (Gen 6 cycle, 2026-04-08). Not yet executed live.

## Goal

We don't know if `bad` is fast or slow because we've never timed it head-to-head against real competitors on the same tasks. This bench fixes that.

For each task in `tasks/`, we run:

- **bad** (this repo) — `bad <goal> --json`
- **browser-use** (Python) — pip install + python runner
- **Stagehand** (TypeScript, Browserbase) — npm install + TS runner
- **Skyvern** (Python, agent + workflow) — pip install + Python runner
- **OpenAI Computer Use** — direct API integration via the OpenAI SDK
- **Claude Computer Use** — direct API integration via Anthropic SDK

For each (framework, task) cell, capture:

- `success: boolean` — task completed successfully (verified by an end-state oracle in the fixture)
- `wallTimeSeconds: number`
- `turnCount: number` — for frameworks that have an explicit notion of turns
- `llmCallCount: number` — when surfaceable
- `inputTokens: number` / `outputTokens: number`
- `cachedInputTokens: number` (when the framework reports it)
- `costUsd: number` — computed via the same pricing table for fairness

## Tasks (planned)

1. **`form-fill-multi-step.json`** — local fixture (already exists as `bench/scenarios/cases/local-long-form.json`). Goal: fill 19 fields across 3 form steps. Oracle: success message visible.
2. **`hn-search-and-extract.json`** — public web. Goal: navigate to news.ycombinator.com, find the top story matching keyword X, extract its score + comment count. Oracle: returned JSON has score:int and comments:int matching the live page.
3. **`github-pr-list.json`** — public web. Goal: open github.com/{owner}/{repo}/pulls, list the open PR titles. Oracle: returned JSON has at least one PR title and the count matches the visible badge.

Each task is runnable by every framework — no framework-specific quirks.

## Output

After every run:
- `results/<framework>/<task-id>/<timestamp>.json` — full per-run record
- `results/_summary.csv` — flat CSV: framework,task,run_id,success,wall_s,turns,llm_calls,input_tokens,output_tokens,cost_usd
- `results/_dashboard.md` — auto-generated comparison table

## Why each competitor

- **browser-use** — closest agent-framework competitor; LangChain-flavored
- **Stagehand** — Browserbase's TypeScript agent; their pitch is "fewest LLM calls for complex tasks"
- **Skyvern** — workflow-style agent with caching; different paradigm worth measuring
- **Computer Use (OAI + Anthropic)** — the foundation models with built-in browser tools; sets the ceiling

## What we'll learn

1. **Are we slow on form-fill?** → if yes, BatchFillAction (Gen 6) is even more urgent
2. **Are we slow on extraction?** → if yes, runScript optimization is the next lever
3. **Are we slow on first-turn cold-start?** → connection warmup (Gen 4) was right; double down
4. **Are we expensive per success?** → cost-per-task is the metric that matters for production deployment
5. **Are we worse on success rate?** → fix correctness first, speed second

## How to run (when implemented)

```bash
# Install all framework runners (one-time)
pnpm bench:competitive:setup

# Run all (framework × task) cells
pnpm bench:competitive:run

# Run a single cell
pnpm bench:competitive:run -- --framework bad --task form-fill-multi-step
pnpm bench:competitive:run -- --framework browser-use --task hn-search-and-extract

# Generate the dashboard
pnpm bench:competitive:dashboard
```

## Status checklist

- [x] Spec written (this file)
- [ ] Common task schema defined (`bench/competitive/tasks/_schema.json`)
- [ ] `form-fill-multi-step.json` task ported from `local-long-form`
- [ ] `bad` runner adapter (`runners/bad.mjs`)
- [ ] `browser-use` runner adapter (`runners/browser-use.py`)
- [ ] `stagehand` runner adapter (`runners/stagehand.ts`)
- [ ] `skyvern` runner adapter (`runners/skyvern.py`)
- [ ] OpenAI Computer Use adapter (`runners/openai-cua.ts`)
- [ ] Claude Computer Use adapter (`runners/anthropic-cua.ts`)
- [ ] `pnpm bench:competitive:setup` script
- [ ] `pnpm bench:competitive:run` script
- [ ] First live run (any single framework × task cell)
- [ ] Dashboard generator
- [ ] Public publication of the results (blog post, README badge)

## First-pass plan: smallest cell first

To validate the scaffold before investing in 6 framework adapters:

1. Implement the `bad` adapter (we control everything, easy)
2. Implement the `browser-use` adapter (Python, single-process, no Browserbase dep)
3. Run BOTH on `form-fill-multi-step`
4. Get a single number: "bad takes X turns and Y seconds; browser-use takes M turns and N seconds"
5. Decide based on the gap whether to invest in the other 4 adapters or pivot
