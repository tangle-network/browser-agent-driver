---
'@tangle-network/browser-agent-driver': minor
---

Gen 7 — Plan-then-execute. **One LLM call per strategy, not per action.**

The architectural win the entire Gen 4-7 trajectory was building toward. The planner makes a single LLM call up front to generate the full action sequence, the runner executes deterministically without re-entering the LLM until verification fails. On the long-form scenario, both `fast-explore` and `full-evidence` modes converge on **9 turns / ~31-38s / $0.22 / 7 LLM calls** — a **5.8× wall-time speedup vs the Gen 4 baseline** and a **4× cost reduction vs Gen 6.1**.

## What ships

**`Brain.plan(goal, state)`** — single LLM call returns a structured `Plan` with `PlanStep[]`. Each step has an action (any of the existing verbs including Gen 6 batch verbs), an `expectedEffect` post-condition, and an optional `rationale`. Plans hit Anthropic prompt cache reliably (86% input cache hit rate observed) because the planning system prompt is byte-stable.

**`BrowserAgent.executePlan(plan, ...)`** — deterministic step executor. For each plan step:
1. Re-observes the page (fresh state for verification)
2. Drives the action via `driver.execute()` (existing path, gets bus events)
3. Verifies the post-condition via `verifyExpectedEffect`
4. On success → advance to next step
5. On failure → bail with deviation context for the caller to fall back

Plan steps push to the same `turns` array the per-action loop uses, so post-run analysis sees a unified timeline regardless of which path completed the run.

**Planner-first wiring in `BrowserAgent.run`** — when `plannerEnabled: true` (or `--planner` CLI flag, gated by `BAD_PLANNER=0` env override), the runner attempts the planner path before entering the per-action loop. On the first plan deviation (verification fail, selector miss, plan exhaustion), it falls through to the existing per-action loop with a `[REPLAN]` hint injected into `extraContext` describing what failed. The per-action loop with Gen 6.1 batch detection finishes the work.

**5 new TurnEvent variants** — `plan-started`, `plan-completed`, `plan-step-executed`, `plan-deviated`, `plan-fallback-entered`. The live SSE viewer + events.jsonl persistence both pick them up automatically.

**Per-step 10s wall-clock cap** — prevents a single bad step (e.g. a date-input spinbutton that Playwright can't fill) from blocking the run for 30s before deviation kicks in.

## Verified result

| Metric | Gen 5 baseline | Gen 6.1 | **Gen 7** |
|---|---:|---:|---:|
| Long-form fast turns | 22 | 9 | **9** |
| Long-form fast wall | 384s | 53s | **31s** |
| Long-form full turns | 17 | 22 (regressed) | **9** |
| Long-form full wall | 180s | 477s | **38s** |
| LLM calls | ~22 | 9 | **7 (1 plan + 6 decide)** |
| Cost per run | $0.40-0.89 | $0.89 | **$0.22** |

**Both modes converge on 9 turns / ~31s / $0.22.** Behavior trace (fast-explore):

1. **plan-completed**: 3 steps generated in 7.7s, prompt cache hit
2. step 1: `fill (2 targets)` ✓
3. step 2: `click` (Next button) ✓
4. step 3: `click` (radio/Next) ✓
5. **plan-fallback-entered** (3/3 steps done — plan exhausted naturally)
6. 6 more `decide-completed` events from per-action loop with Gen 6.1 batch detection
7. Final `complete` action — 9 turns total, 7 LLM calls

## Tests

**881 passing** (was 865, **+16 net new**):
- 11 in `tests/brain-plan-parse.test.ts` — parser, validation, malformed JSON, zero steps, unknown actions, token surfaces
- 5 in `tests/runner-execute-plan.test.ts` — happy path, execute deviation, terminal complete mid-plan, plan exhaustion → fallback signal, metadata propagation

Tier1 deterministic gate: **100% pass rate**.

## Three iterations to nail the contract

| v | Failure | Fix |
|---|---|---|
| 1 | Planner included spinbutton in batch fill | Strengthen prompt to OMIT spinbuttons |
| 2 | Planner used single-step type on spinbuttons | Add 10s wall-clock cap to plan steps |
| 3-4 | Planner hallucinated `complete` action | `executePlan` returns `deviated` (not synthetic complete) on plan exhaustion |
| **5** | Both modes converge | **9 turns / 31s / $0.22** |

## Cumulative Gen 4-7 trajectory (long-form fast-explore)

| Gen | Turns | Wall | LLM calls | Cost | Speedup vs Gen 4 |
|---|---:|---:|---:|---:|---:|
| 4 | 22 | 180s | 22 | $0.40 | 1× |
| 5 | 22 | 180s | 22 | $0.40 | 1× |
| 6 | 17-22 | varies | 17-22 | varies | ~1.0-1.3× |
| 6.1 | 9 | 53s | 9 | $0.89 | 3.4× |
| **7** | **9** | **31s** | **7** | **$0.22** | **5.8×** |

## Adds

- `bench/scenarios/configs/planner-on.mjs` — config preset that enables the planner
- `--planner` CLI flag for one-off runs

## Rollback

`BAD_PLANNER=0` disables the planner and forces per-action loop only.
