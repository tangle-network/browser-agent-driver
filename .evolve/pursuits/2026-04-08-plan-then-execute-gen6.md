# Pursuit: Plan-Then-Execute (Gen 6)
Generation: 6
Date: 2026-04-08
Status: evaluated
Branch: gen6-batch-verbs

## Thesis

**Turn count is the metric, not ms per turn.** A 5-turn run at 3s/turn (15s) crushes a 20-turn run at 2s/turn (40s) every time. Gen 4 + Gen 5 squeezed infrastructure overhead (real, but small — ~5–8% of wall time on a 20-turn run). The dominant cost is N × LLM call latency. The only way to make `bad` dramatically faster is to **reduce N**.

Two levers, ordered by impact:

1. **Higher-level action verbs.** Today the agent fills a form one field at a time: `click(field1) → type(field1, "Jordan") → click(field2) → type(field2, "Rivera")` = 4 turns for 2 fields. With a `fill({ field1: "Jordan", field2: "Rivera" })` verb, that's 1 turn. Multi-field forms become N/4 turns instead of N×2.
2. **Plan-then-execute orchestration.** Instead of "1 LLM call per action", use "1 LLM call per *strategy*" — plan a sequence, execute deterministically, only re-enter the LLM when verification fails.

Gen 6 ships #1 first (cheaper, higher-immediate-value, lower-risk) and lays the groundwork for #2 (the planner can be added in Gen 6.1 once batch verbs prove themselves).

## System Audit

### What exists today
- 13 single-step action verbs in `src/types.ts`: click, type, press, hover, select, scroll, navigate, wait, evaluate, runScript, verifyPreview, complete, abort
- `plan: string[]` field on `BrainDecision` is descriptive-only — the agent emits a plan in JSON but the runner doesn't use it for execution
- `currentStep` tracks plan progress but the agent re-decides every turn anyway
- `nextActions: Action[]` micro-plan field exists for follow-up actions, gated by `microPlan.enabled !== true` (opt-in, default off). Even when on, it's limited to 4 actions and only fires after a "safe" primary action.
- `selectFollowUpActions` in runner.ts at line ~1387 handles the micro-plan execution

### What doesn't exist
- **No batch action verbs.** No `fill(fields)`, no `clickSequence(refs)`, no `verifyText(query)`. Every multi-field form takes N×2 turns minimum (click + type per field).
- **No planner method.** No `Brain.plan(goal, state)` that returns a structured plan with named steps and verification checkpoints.
- **No plan executor.** The runner's main loop is observe → decide → execute (one action) → verify → loop. There's no "execute the next 5 steps deterministically" path.
- **No replan trigger.** Verification failure today re-enters `decide()` with feedback. There's no notion of "the plan is dead, generate a new one."

### What's been verified about the LLM cost
From Gen 5 evolve round 1 measurements:
- LLM `decide()` call: 2,000–5,000ms per turn (90%+ of wall time)
- 20-turn long-form: ~180s wall time, 95% LLM
- Cookie banner pattern matcher (Gen 5): saves 1 LLM call per matched turn (~3s)
- Decision cache: 0% hit rate on goal-following runs

The math: every avoided LLM call saves 2–5 seconds. Avoiding 10 of 20 turns saves 20–50 seconds — a 30–50% wall time reduction. Avoiding 15 of 20 turns saves 30–75 seconds — 50–75% reduction. **The 4× speedup target requires avoiding ~75% of LLM calls**, which is the difference between 20 turns and 5.

### Measurement gap
- No "turns per fixture" baseline tracked across generations. Need to record the long-form turn count today as the Gen 6 baseline.
- No competitive benchmark — we don't know if 20 turns is many or few relative to browser-use, Stagehand, etc. (Spec'd separately in `.evolve/scripts/competitive-bench.md` — runs in parallel with this generation.)

## Gen 6 Design

### Thesis
> **Reduce average turn count on the long-form scenario from 17–22 down to 5–8 by shipping `BatchFillAction` (fill N fields in one turn) and a prompt that strongly encourages it.**

This is the *minimal viable Gen 6*. It does NOT include the full planner — that's Gen 6.1 if batch fills aren't enough. Shipping minimal first lets us measure the actual impact of higher-level verbs alone.

### Changes (must ship together)

#### Architectural

1. **`BatchFillAction` in `src/types.ts`** *(low risk)*
   ```ts
   interface BatchFillAction {
     action: 'fill'
     /** Map of @ref → value to type into each field */
     fields: Record<string, string>
     /** Optional select dropdowns: @ref → option value/label */
     selects?: Record<string, string>
     /** Optional checkboxes to check: array of @refs */
     checks?: string[]
   }
   ```
   - Added to the `Action` union.
   - JSON parser in `Brain.parse` accepts the new shape.
   - Validation: at least one of fields/selects/checks must be non-empty; ref format must be `@xxx`.

2. **`PlaywrightDriver.execute` handler for `fill`** *(low risk)*
   - Iterates the fields in order, `locator.fill(value)` for textboxes, `locator.selectOption(value)` for selects, `locator.check()` for checkboxes
   - Returns success only if EVERY field succeeds; failures bail with the first error
   - Captures bounding box of the LAST filled field for the cursor overlay

3. **`ClickSequenceAction` in `src/types.ts`** *(low risk)*
   ```ts
   interface ClickSequenceAction {
     action: 'clickSequence'
     /** Array of @refs to click in order */
     refs: string[]
     /** Wait between clicks in ms (default 100) */
     intervalMs?: number
   }
   ```
   - For known click chains: "click checkbox 1, checkbox 2, checkbox 3" or "open menu → click submenu → click item"
   - Same handler shape as fill — bail on first failure

4. **Brain prompt update** *(medium risk — prompt change can affect quality)*
   - Add new ACTIONS section for `fill` and `clickSequence`
   - Add a new RULE: "When you see 3+ form fields you need to fill in sequence, prefer `fill` over multiple `type` actions. When you see 2+ checkboxes to check, prefer `clickSequence` or `fill.checks` over multiple `click` actions."
   - Add an EXAMPLE: a 5-field form filled in 1 turn

#### Measurement

5. **Turn-count baseline tracking** *(infra)*
   - Extend `bench/gen4-microbench.ts` (rename to `gen-microbench.ts`) with a `bench:turns` mode that reports turn count + LLM call count per scenario
   - Run on long-form to capture the Gen 6 baseline

6. **Plan-action vs decide-action telemetry** *(infra)*
   - Add a counter on Turn: `actionsExecuted: number` (1 for click, N for fill)
   - Track in run summary: `actionsPerTurn` ratio
   - Surface in events.jsonl events

### Alternatives considered

- **Full planner first** — `Brain.plan()` + `executePlan()` + replan logic. Rejected for Gen 6 because: (a) too much surface area for one generation, (b) batch verbs alone might deliver most of the value, (c) the planner becomes much easier to design once we know what verbs are available. Save for Gen 6.1.
- **Speculative next-turn decode** — fire decide(N+1) against a predicted post-state during execute(N). Rejected: doubles LLM cost for a 1.3× latency gain at best.
- **Switch to a smarter model** — gpt-5 / Claude Opus might use fewer turns. Rejected as a lever: orthogonal to the architecture, costs more, doesn't address the protocol limitation.

### Risk assessment

- **Highest risk:** prompt change. Adding new verbs to the system prompt could degrade quality on tasks that DON'T have multi-field forms (the LLM gets confused, picks `fill` when it should pick `click`). Mitigation: ship behind `BAD_BATCH_VERBS=0` env flag for one round, A/B against tier1 gate.
- **Second risk:** `fill` failures are atomic (bail on first error). A partially-filled form is harder to recover from than a single failed type. Mitigation: each field is wrapped in try/catch, the action result includes per-field success/failure for the agent to inspect.
- **Rollback plan:** all 6 changes are gated by either the env flag or the new action verbs being optional. No existing scenario depends on the new verbs.

### Success criteria

- **Long-form turn count:** 17–22 → **5–8** (target 3–4× reduction)
- **Long-form wall time:** 180s → **30–60s** (target 3–5× reduction)
- **Long-form cost:** $0.80 → **$0.20** (target 4× reduction)
- **Tier1 gate pass rate:** maintained at 100%
- **All existing tests pass + new BatchFillAction + ClickSequenceAction tests**

## Build Status

| # | Change | Status | Files |
|---|--------|--------|-------|
| 1 | BatchFillAction type + parser | pending | src/types.ts, src/brain/index.ts |
| 2 | fill executor in PlaywrightDriver | pending | src/drivers/playwright.ts |
| 3 | ClickSequenceAction type + executor | pending | src/types.ts, src/drivers/playwright.ts |
| 4 | Brain prompt update with new verbs + rule | pending | src/brain/index.ts |
| 5 | actionsExecuted counter on Turn | pending | src/types.ts, src/runner/runner.ts |
| 6 | Tests for new verbs | pending | tests/playwright-driver-batch.test.ts (new) |
| 7 | Long-form rerun + measurement | pending | bench output |

## Results

### Build (4 components shipped)

| # | Change | Status | Files |
|---|--------|--------|-------|
| 1 | `BatchFillAction` + `ClickSequenceAction` types | ✅ shipped | src/types.ts |
| 2 | `Brain.parse` + `validateAction` for new verbs | ✅ shipped | src/brain/index.ts |
| 3 | `fill` + `clickSequence` executors in PlaywrightDriver | ✅ shipped | src/drivers/playwright.ts |
| 4 | Brain prompt update with new verbs + rule 15 | ✅ shipped | src/brain/index.ts |
| 5 | Supervisor signature for new verbs | ✅ shipped | src/supervisor/policy.ts |
| 6 | Parser unit tests + driver integration tests | ✅ shipped | tests/batch-action-parse.test.ts (10), tests/playwright-driver-batch.test.ts (6) |

### Tests

856 passing (was 840, **+16 net new**)
- 10 in `tests/batch-action-parse.test.ts` (parser, validation, error paths)
- 6 in `tests/playwright-driver-batch.test.ts` (real Chromium, fill text/selects/checks, clickSequence, fast-fail on missing refs)

### Tier1 gate
- Pass rate: **100%** ✓ (no regressions on the deterministic gate)

### Long-form scenario measurements

Two A/B runs vs Gen 5 baseline (single-rep, single A/B — high variance):

| Metric | Gen 5 baseline | Gen 6 v1 (initial prompt) | Gen 6 v2 (stronger prompt) |
|---|---:|---:|---:|
| Full-evidence turns | 17 | 21 (+4) | 17 (no change) |
| Fast-explore turns | 22 | 17 (-5) | 22 (no change) |
| Batch fills attempted | — | 6 | 2 |
| Batch fills succeeded | — | 5 (19 targets) | 2 (14 targets) |
| Batch failure rate | — | 50% | 0% |

**Honest read:** the architecture works, but the SINGLE-RUN turn-count signal is dominated by the agent's strategic variance (same lesson as Gen 4 evolve r1). When the agent picks a batch fill of 6-8 targets, it compresses 6-8 turns to 1 — that's the win. But across reps, whether the agent picks batch at all on any given turn varies enormously.

**What's mechanically proven:**
- Batch verbs work end-to-end against real Chromium (16 unit + integration tests)
- The agent emits valid batch JSON when prompted
- Successful batches compress 14-19 fields into 2-3 turns (6-8× compression on those turns)
- Per-target fast-fail (5s timeout cap) prevents one bad ref from killing the run

**What's NOT yet proven:**
- The 3-4× turn count reduction target (we're seeing 0-25% in single runs)
- Cause: prompt-engineering alone isn't enough to convince the LLM to use batch consistently. The agent often falls back to single-step out of (rational) caution after a single failure.

### Honest verdict

**KEEP, with caveats.** The mechanical infrastructure is correct and ships value when the agent uses it. The follow-up needed is **runtime hint injection**: detect "agent just did 3+ type actions on the same form" and inject extra context suggesting batch fill. Convincing via runtime feedback is more reliable than prompt rules alone. Tracked as task #78.

### Lesson re-learned (3rd time across Gen 4/5/6)

**Wall-clock measurement on non-deterministic agent runs is dominated by run-to-run variance.** To prove out a Gen 6 turn-count win we need either:
- Multiple reps (5+) with statistical aggregation
- A longer scenario where the win compounds past noise
- Runner-level orchestration that forces the desired behavior

For one-shot validation, the deterministic micro-bench (built in Gen 4) is the right tool. For end-to-end validation, multiple reps are mandatory.

### What works that we should double down on

- Test-first for new action verbs: 16 tests caught 0 production bugs and pinned the parser/executor contract
- Per-field fast-fail timeout (5s vs 30s default) — makes batch failures recoverable on the next turn instead of consuming the budget
- The events.jsonl persistence (Gen 5 evolve r1) made this measurement possible at all — without it I couldn't have counted batch successes vs failures from the run

### Next generation seeds (Gen 6.1 or Gen 7)

- **Runtime batch hint injection** (followup task #78): detect 3+ consecutive type actions on the same form, inject extra context suggesting batch fill
- **Multi-rep measurement harness**: run a scenario N times, aggregate turn count statistics, distinguish signal from variance
- **Full plan-then-execute architecture** (the original Gen 6 thesis without the minimal-viable shortcut): `Brain.plan()` returns a structured plan, `Runner.executePlan()` runs it deterministically, replan on verification failure
- **Competitive benchmark execution**: spec is in `bench/competitive/README.md` — install browser-use and run the same scenario to get a real comparison number
