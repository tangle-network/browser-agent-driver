---
'@tangle-network/browser-agent-driver': minor
---

Gen 7 + 7.1 — Plan-then-execute with replan-on-deviation. **One LLM call per strategy chunk, not per action.**

A planner makes a single LLM call up front to generate a structured action plan, the runner executes it deterministically, and on deviation it **replans** instead of immediately falling through to the per-action loop. Validated under the new measurement-rigor protocol (`docs/EVAL-RIGOR.md`): **3 reps each side, mean ± min/max**, no single-run claims.

## Verified result (long-form fast-explore, 3 reps each, same day, same model)

| metric | Gen 7 baseline (mean) | Gen 7.1 (mean) | Δ | reps | challenger min/max | verdict |
|---|---:|---:|---:|---:|---|---|
| wall-time | 128.7s | **35.9s** | **−92.8s (−72%)** | 3 | 33.9s / 37.4s | **WIN — 3.6× faster** |
| turns | 20.7 | **11.0** | **−9.7 (−47%)** | 3 | 9 / 13 | **WIN** |
| tokens | 250,434 | **10,724** | **−239,710 (−96%)** | 3 | 9,138 / 11,584 | **WIN — 23× fewer** |
| cost ($) | $0.5007 | **$0.0424** | **−$0.46 (−92%)** | 3 | $0.0385 / $0.0453 | **WIN — 12× cheaper** |
| pass rate | 100% | 100% | 0 | 3 | — | comparable |

The spread test passes: the wall-time delta (92.8s) exceeds the **sum** of both sides' worst-case spreads (Gen 7: 53s, Gen 7.1: 3.5s), so this is a real architectural win and not run-to-run variance. Gen 7.1 is also dramatically **more consistent** (3.5s spread vs 53s) — the planner+replan loop reduces variance because it stays out of the per-action LLM loop where most variance lived.

## What ships

**`Brain.plan(goal, state, { extraContext? })`** — single LLM call returns a structured `Plan` with `PlanStep[]`. Each step has an action (any verb including Gen 6 batch verbs), an `expectedEffect` post-condition, and an optional `rationale`. The optional `extraContext` is how the runner injects deviation history into a replan call without changing the system prompt — preserves Anthropic prompt-cache hits across the initial plan and all replans.

**`BrowserAgent.executePlan(plan, ..., planCallTokens?)`** — deterministic step executor. For each plan step:
1. Re-observes the page
2. Drives the action via `driver.execute()`
3. Verifies the post-condition via `verifyExpectedEffect`
4. On success → advance; on failure → bail with deviation context
5. Per-step 10s wall-clock cap so a single bad step can't block the run for 30s

The `planCallTokens` parameter attaches the Brain.plan() LLM call's token usage to the FIRST plan-step turn. Without this, runs that stay in plan-mode (Gen 7.1) reported $0 cost while their Brain.plan() calls actually spent real tokens — a metric attribution bug caught by the rigor gates.

**Replan loop in `BrowserAgent.run`** — when `plannerEnabled: true` (or `--planner` CLI flag, `BAD_PLANNER=0` to disable):
1. Initial plan call → execute deterministically
2. On deviation: re-observe the page, build a `[REPLAN N/3]` deviation context, call `Brain.plan()` again
3. Cap at **3 replans** (4 plan calls total per run)
4. On exhaustion: fall through to the per-action loop with a `[REPLAN]` hint

**6 new TurnEvent variants** — `plan-started`, `plan-completed`, `plan-step-executed`, `plan-deviated`, `plan-fallback-entered`, `plan-replan-started` (Gen 7.1). The live SSE viewer + events.jsonl persistence both pick them up automatically.

## Measurement rigor (`docs/EVAL-RIGOR.md`)

Same PR ships the rigor protocol that caught this generation's earlier overclaims:
- **`pnpm bench:validate`** (`scripts/run-multi-rep.mjs`) — canonical single-config N-rep harness with mean/min/max output. **Exits non-zero on `--reps < 3`** unless explicitly opted out via `--allow-quick-check`.
- **`docs/EVAL-RIGOR.md`** — names the only 3 sanctioned validation paths (`bench:validate`, `ab:experiment`, `research:pipeline --two-stage`) plus the verbatim summary table format.
- **`CLAUDE.md` Measurement Rigor section** — 10 hard rules including "no single-run speedup claims, ever."
- **`scripts/lib/static-fixture-server.mjs`** — extracted shared fixture-server lib so the rigor harness drives the same fixtures the CI gate does.
- **`scripts/run-mode-baseline.mjs`** — now substitutes `__FIXTURE_BASE_URL__` like `run-scenario-track.mjs` does, so single-scenario runs reach the local fixture server consistently.

## Tests

**887 passing** (was 881, +6 net new for this PR):
- 3 in `tests/brain-plan-parse.test.ts` covering Gen 7.1 `extraContext`: omits/injects from user prompt, system prompt remains byte-stable across replans (cache hit preservation)
- (existing 11) `brain-plan-parse.test.ts` parser/validator coverage
- (existing 5) `runner-execute-plan.test.ts` happy path / deviation / terminal complete / exhaustion / metadata

Tier1 deterministic gate: **100% pass rate** maintained.

## Honest known issues

- **Plan-call token attribution** is "good enough" not "perfect": the entire plan call's tokens land on the first plan step's turn, not distributed across the steps. The run-level total is correct; per-step costs in detailed reports overstate the first step. Acceptable for now; a per-step distribution model can come later if it matters.
- **The Gen 7 baseline measured here (128.7s mean)** is slower than the original Gen 7 work's reported numbers (~50s mean). That earlier number was contaminated by single-run variance and stale comparisons. This PR measures both Gen 7 and Gen 7.1 under identical conditions on the same day, which is the only comparison that survives the new rigor rules.

## Three iterations to nail Gen 7.1

| v | Failure | Fix |
|---|---|---|
| 1 | `spawnSync` in multi-rep harness blocked the parent event loop, embedded fixture server couldn't respond, agent observe() hung forever with no error | Switch to async `spawn` + Promise wrapper |
| 2 | Plan-call tokens reported as $0 because plan turns had no `tokensUsed` field (only per-action turns did) | Attach `planCallTokens` to first plan-step turn in `executePlan` |
| **3** | All paths handled correctly | **Mean 35.9s / $0.04 / 11 turns, 3-rep validated** |

## Rollback

`BAD_PLANNER=0` disables the planner (and replan loop) entirely and forces per-action loop only.
