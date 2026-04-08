# Pursuit: Plan-then-Execute (Gen 7)
Generation: 7
Date: 2026-04-08
Status: spec
Branch: TBD

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

## Why this is the next generation

- Gen 6 proved batch verbs save LLM calls per action
- Gen 6.1 proved runner-side enforcement makes the agent use them reliably
- **Gen 7 takes it to the limit: stop calling the LLM for actions entirely. Plan once, execute deterministically, replan on failure.** The architecture parallels how human users actually work — you don't decide on each click, you have a mental model of the form and execute it.

This is where `bad` becomes visibly faster than every competitor on the same task.
