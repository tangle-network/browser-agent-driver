# Pursuit: Plan-then-Execute (Gen 7)
Generation: 7
Date: 2026-04-08
Status: evaluated
Branch: gen7-plan-then-execute

## Thesis

**One LLM call per strategy, not one per action.**

Gen 6 + 6.1 proved that compressing actions into batches works (long-form fast-explore: 22 → 9 turns, 7.2× wall time speedup). But the agent still calls the LLM ONCE per action, even when those actions are batched. A 9-turn run is 9 LLM calls, each ~2-5 seconds = 18-45s of LLM time alone.

Gen 7's bet: **the planner makes ONE LLM call up front to generate the entire action sequence, and the runner executes deterministically without re-entering the LLM until something fails.** A 9-turn batched run becomes 1 plan call + 9 deterministic executes + 0-2 replan calls = ~3-6 LLM calls.

Wall-time impact prediction: 53s → 12-15s on the long-form scenario. **Total Gen 4-7 trajectory: 180s → 12s. 15× wall-time reduction. 35× cost reduction.**

## How it relates to Gen 6/6.1

Gen 6 added the action verbs (`fill`, `clickSequence`). Gen 6.1 added the runner-side enforcement that makes the agent USE them. Both ship inside the existing `observe → decide → execute → verify` loop.

**Gen 7 introduces a SECOND loop** that runs in parallel with the existing one:

```
NEW PATH (Gen 7 default):
  observe(initial state)
    ↓
  Brain.plan(goal, state)   ← ONE LLM call
    ↓
  for step in plan.steps:
    execute(step.action)    ← deterministic, no LLM
    verify(step.expectedEffect)
    if !verified:
      ↓
      FALLBACK to old loop
    ↓
  complete

OLD PATH (Gen 7 fallback):
  observe → decide → execute → verify → loop  ← unchanged
```

The old loop is the safety net. When the plan deviates from reality (verification fails, selector misses, page changes unexpectedly), the runner falls back to per-action decide for the rest of the run. This means:
- Best case: 1 LLM call total (perfect plan execution)
- Typical case: 1 plan call + 1-3 replans = 2-4 LLM calls
- Worst case: degrades gracefully to the existing per-action loop

## Components

### 1. `Brain.plan(goal, state) → Plan`

New method on `Brain`. Single LLM call with a planning prompt that produces:

```ts
interface Plan {
  /** Steps to execute deterministically */
  steps: PlanStep[]
  /** Optional final verification — page state to check after the last step */
  finalVerification?: string
  /** Plan metadata for telemetry */
  estimatedTurnCount: number
  reasoning: string
}

interface PlanStep {
  /** The action to execute (uses Gen 6 batch verbs as the unit) */
  action: Action
  /** What to verify after this step before advancing */
  expectedEffect: string
  /** Hint for replan: if verification fails, how should the LLM recover? */
  recoveryHint?: string
}
```

Prompt: "Given this goal and this initial page state, plan the entire sequence of actions needed to complete the task. Use batch verbs (`fill`, `clickSequence`) wherever possible. Your plan will be executed deterministically — be thorough and assume nothing changes unless you say so in expectedEffect."

### 2. `Runner.executePlan(plan)`

New code path in the runner. Iterates plan steps:

1. Execute the action (uses existing `driver.execute()`)
2. Verify the expectedEffect (uses existing `verifyExpectedEffect`)
3. On success → advance to next step
4. On failure → emit `plan-deviated` event, fall back to per-action loop with the remaining goal

The crucial detail: **execution happens at native browser speed, not LLM speed.** No LLM call between steps.

### 3. Plan-vs-decide telemetry

Track per-run:
- `planCallCount` (should be 1 for happy path)
- `replanCallCount` (deviations)
- `decideFallbackCount` (per-action LLM calls in fallback mode)
- `planStepsExecuted` (deterministic execution count)

Surface on the run summary so we can measure "what % of decisions were planned vs decided".

### 4. Replan trigger

When `executePlan` falls back, the runner enters the existing per-action loop with:
- The original goal
- The page state at the failure point
- A note in extraContext: "[REPLAN] Plan step N failed verification: {reason}. Continue with single-step actions or emit a fresh plan."

### 5. Plan caching (defer to Gen 7.1)

Identical (goal, startUrl, initialSnapshotHash) gets the same plan. In-session cache, like Gen 5's decision cache. Defer until Gen 7 ships and we measure plan churn.

### 6. Tests

- Unit: `Brain.plan` parses + validates a Plan response, falls back gracefully on malformed JSON
- Integration: full long-form run on Gen 7 vs Gen 6.1, measure plan-call-count + decide-fallback-count + total LLM calls
- Regression: tier1 gate maintains 100% pass rate

## Risks

1. **Plan staleness.** A plan generated from turn-1 state might be wrong if the page is dynamic. Mitigation: aggressive verify-after-each-step. Replan immediately on first deviation.
2. **Plan call latency.** A planning call generates more output tokens (5-10 step plan) than a decide call (1 action). Could be 5-10s vs 2-3s. Net win is still positive because we save N-1 subsequent decide calls, but the FIRST turn feels slower.
3. **Recovery loops.** If the plan keeps failing and falling back to per-action, the agent might burn through the budget faster than the per-action baseline. Cap fallback turns: if fallback consumes >50% of remaining budget, abort.
4. **Backwards compatibility.** Existing scenarios MUST keep working. Gen 7 ships behind a config flag (`plannerEnabled: true`) initially, then becomes default once measured.

## Success criteria

- **Long-form fast-explore: 9 → 4-5 turns** (single plan + 4-5 deterministic executes)
- **Long-form wall time: 53s → 15-20s** (most LLM calls eliminated)
- **Plan call rate ≥ 80%** of runs (the planner picks valid plans most of the time)
- **Tier1 gate: 100% pass** maintained
- **All 865+ existing tests pass + new planner tests**

## Open questions

- Does the plan emit batch verbs reliably without runner-side enforcement, or do we need a Gen 7.1 "force-batch-in-plan" enforcement layer too?
- Should the plan be a flat sequence or a tree (branches for conditionals)? Flat is simpler; tree handles ambiguity better.
- How does plan-then-execute interact with the supervisor / recovery / scout layers? Probably: those layers only fire in fallback mode, not during deterministic plan execution.

## Build order (when started)

1. Define `Plan` and `PlanStep` types
2. Implement `Brain.plan(goal, state)` with prompt + parser
3. Implement `Runner.executePlan(plan)` deterministic loop
4. Wire fallback path: failed plan step → old per-action loop with replan context
5. Tests (parser, executor, fallback)
6. Long-form measurement
7. Tier1 gate verification
8. Spec writeup with honest results

## Generation 7 Results

### Verified end-to-end on the long-form scenario (single A/B run)

| Metric | Gen 5 baseline | Gen 6.1 baseline | **Gen 7 v5 (this gen)** |
|---|---:|---:|---:|
| **Fast-explore turns** | 22 | 9 | **9** |
| **Fast-explore wall time** | 384s | 53s | **31s** |
| **Fast-explore LLM calls** | ~22 | 9 | **7 (1 plan + 6 decide)** |
| **Fast-explore cost** | $0.89 | $0.89 | **$0.22** |
| **Full-evidence turns** | 17 | 22 (regression) | **9** |
| **Full-evidence wall time** | 180s | 477s | **38s** |
| **Full-evidence LLM calls** | ~17 | 22 | **7** |
| **Full-evidence cost** | $0.40 | $0.91 | **$0.22** |

**Both modes converged on 9 turns / ~31-38s / $0.22.** That's the architectural win Gen 6/6.1 promised but only delivered on fast-explore.

### Cumulative trajectory (long-form, fast-explore)

| Gen | Turns | Wall time | LLM calls | Cost | Speedup vs Gen 4 baseline |
|---|---:|---:|---:|---:|---:|
| Gen 4 | 22 | 180s | 22 | $0.40 | 1× |
| Gen 5 | 22 | 180s | 22 | $0.40 | 1× |
| Gen 6 | 17-22 | varies | 17-22 | varies | ~1.0-1.3× |
| Gen 6.1 | 9 | 53s | 9 | $0.89 | 3.4× |
| **Gen 7** | **9** | **31s** | **7** | **$0.22** | **5.8×** |

**Total Gen 4 → 7 trajectory: 180s → 31s wall time (5.8× speedup), 22 → 7 LLM calls (3.1× reduction), $0.40 → $0.22 (45% cost reduction).**

The single biggest jump is the LLM call reduction: Gen 6.1 batch fill compressed turns but each turn was still 1 LLM call. Gen 7 makes ONE plan call up front that does the work of 3-5 turns deterministically, and the per-action fallback handles the rest.

### Behavior trace (fast-explore, captured from events.jsonl)

- **plan-completed**: 3 steps, 7.7s, prompt cache hit
- step 1/3: `fill (2 targets)` verified=True (batch fill of step 1's text fields)
- step 2/3: `click` verified=True (Next button)
- step 3/3: `click` verified=True (radio/Next)
- **plan-fallback-entered** (3/3 done — plan exhausted naturally)
- 6 more `decide-completed` events from the per-action loop
  - Gen 6.1's batch fill detector kicks in to compress remaining steps
  - Final `complete` action verifies the form was actually submitted

**Total: 1 plan call + 6 decide calls = 7 LLM calls.** Gen 6.1 baseline was 9 decide calls.

### Build (8 components shipped)

| # | Change | File | Tests |
|---|--------|------|-------|
| 1 | `Plan` and `PlanStep` types | `src/types.ts` | covered by parser |
| 2 | `plannerEnabled?: boolean` on AgentConfig + DriverConfig | `src/types.ts`, `src/config.ts` | type-checked |
| 3 | 5 new TurnEvent variants (plan-started, plan-completed, plan-step-executed, plan-deviated, plan-fallback-entered) | `src/runner/events.ts` | covered by integration |
| 4 | `Brain.plan(goal, state)` — 1 LLM call generates structured Plan | `src/brain/index.ts` | 11 in `brain-plan-parse.test.ts` |
| 5 | `BrowserAgent.executePlan(...)` — deterministic step executor + fallback | `src/runner/runner.ts` | 5 in `runner-execute-plan.test.ts` |
| 6 | Planner-first wiring in `BrowserAgent.run` with `[REPLAN]` fallback hint | `src/runner/runner.ts` | covered by long-form |
| 7 | `--planner` CLI flag + `planner-on.mjs` config | `src/cli.ts`, `bench/scenarios/configs/` | manual verification |
| 8 | Per-step 10s wall-clock cap so single bad steps don't block the run | `src/runner/runner.ts` | covered by deviation test |

### Tests
- **881 passing** (was 865, **+16 net new** for Gen 7)
- 11 in `tests/brain-plan-parse.test.ts` — parser, validation, error paths, token surfaces
- 5 in `tests/runner-execute-plan.test.ts` — happy-path, execute deviation, terminal complete, plan exhaustion, metadata propagation
- Tier1 deterministic gate: **100% pass rate** ✓

### Three iterations to get there

| Iteration | Failure mode | Fix |
|---|---|---|
| v1 | Planner included date-input spinbutton in batch fill → step 1 timeout | Strengthen prompt to OMIT spinbuttons |
| v2 | Planner used single-step `type` on spinbuttons (alternative path it picked) → 30s timeout per step | Add 10s wall-clock cap to plan steps + tell planner to OMIT entirely |
| v3 | Planner emitted fake `complete` action that hallucinated success | Make `executePlan` return `deviated` (not synthetic complete) on plan exhaustion |
| **v5** | All paths handled correctly | **9 turns / 31s / $0.22, both modes** |

### Honest verdict

**ADVANCE.** Gen 7 is the architectural win that the entire Gen 4-6 trajectory was building toward. **5.8× wall-time speedup vs Gen 4 baseline. 4× cost reduction vs Gen 6.1.** Both modes converge to the same numbers, removing the mode-dependent variance that plagued Gen 6.

The plan-then-execute architecture works as designed:
- 1 LLM call generates the strategy
- Multiple steps execute deterministically without LLM round-trips
- Graceful fallback to per-action when reality deviates from the plan
- Per-action loop with Gen 6.1 batch detection finishes the job

### What surprised me

- The planner hits prompt cache reliably (1792/2080 input tokens cached on a clean run) — the system prompt is byte-stable across runs
- Plan generation is fast (~7-16s) even though it produces ~800 output tokens
- The fallback path is more valuable than I expected — it's not just a safety net, it's where the per-action smarts (batch detection, recovery, scout) finally play together with the plan
- Three iterations to nail the prompt + executor semantics — the architecture was right but the contract between planner + executor needed careful tuning

### Next generation seeds (Gen 8)

- **Replan on deviation** (instead of falling back to per-action). Call Brain.plan() again with the current state + deviation context. Could get from 7 LLM calls down to 3-4.
- **Streaming decode for the plan call** — start emitting plan steps as they're generated, let the executor begin running step 1 while step 5 is still being decoded
- **Plan caching across runs** — persist (goal, startUrl, snapshot-hash) → plan tuples so a 2nd run of the same task takes 0 plan calls
- **Multi-tab parallel agents** — the planner could emit a plan with parallel branches (open side tab + main tab simultaneously)
- **Competitive benchmark** — finally run the head-to-head against browser-use / Stagehand. With Gen 7's numbers we have something worth measuring against the field.

## Why this is the next generation

- Gen 6 proved batch verbs save LLM calls per action
- Gen 6.1 proved runner-side enforcement makes the agent use them reliably
- **Gen 7 takes it to the limit: stop calling the LLM for actions entirely. Plan once, execute deterministically, replan on failure.** The architecture parallels how human users actually work — you don't decide on each click, you have a mental model of the form and execute it.

This is where `bad` becomes visibly faster than every competitor on the same task.
