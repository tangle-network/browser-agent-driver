# Pursuit: Gen 21 — Parallel Tab Exploration
Generation: 21 (building on Gen 27 baseline)
Date: 2026-04-11
Status: designing

## System Audit

### What exists and works
- `MultiActorSession` (src/multi-actor.ts): fully built, creates isolated BrowserContext + Page + Driver + BrowserAgent per actor, has `parallel()` method for concurrent execution
- `BrowserAgent.run()`: single-page agent loop with observe → decide → execute → verify
- Evidence accumulation: `extractedEvidence` + `goalVerificationEvidence` + `streamingEvidence` in runner
- Planner: DOM planner with screenshot that emits N deterministic steps

### What exists but isn't integrated
- `MultiActorSession.parallel()` is for multi-USER testing (separate auth). Not wired for single-user multi-tab goal decomposition.
- Evidence from parallel runs isn't merged — each actor has independent results

### What was tested and failed
- No prior attempt at goal decomposition

### What doesn't exist yet
- **Goal decomposer**: LLM call that detects compound goals and splits them
- **Sub-goal router**: assigns sub-goals to tabs with start URLs
- **Evidence merger**: combines results from parallel sub-agents into one answer
- **Budget splitter**: divides token/turn budget across sub-agents
- **Trigger logic**: decides when to decompose vs run sequentially

### Measurement gaps
- No metric for "compound task" pass rate separate from overall pass rate
- No timing data on comparison tasks specifically

## Current Baselines
- WebVoyager Gen 25: 539/590 (91.3%), $54, $0.09/task
- Compound tasks (34 total): 28/34 pass (82%)
- Compound task failures: 5 Google Flights comparisons + 1 Spotify
- WebbBench-50: 44/50 (88%)
- Competitive: 10/10 (100%)

## Diagnosis

The 6 compound task failures are NOT caused by sequential execution — they're Google Flights form stalls. Parallel tabs wouldn't fix them.

However, parallel tabs add value in three areas:
1. **Speed**: comparison tasks ("compare X vs Y") take 15-25 turns sequentially. With parallel tabs, each sub-goal runs independently in ~5-10 turns, cutting wall time in half.
2. **Reliability**: multi-item collection ("find 5 restaurants with rating > 4.8") currently loses context between items. Evidence accumulator prevents this.
3. **Capability ceiling**: WebVoyager doesn't test true multi-site comparison tasks. Real-world goals like "find the cheapest flight across Google Flights, Kayak, and Skyscanner" need parallel tabs.

**Honest WebVoyager impact: +1-2pp at most** (maybe flip 1-2 of the 6 compound failures). The real value is speed + capability for non-benchmark tasks.

## Generation 21 Design

### Thesis
Decompose compound goals into parallel sub-agent tabs. Reuse the existing MultiActorSession infrastructure for execution. The new code is the intelligence layer (decompose + merge), not the execution layer.

### Architecture

```
Goal → GoalDecomposer (1 cheap LLM call)
  ├── Simple goal → BrowserAgent.run() as before (no change)
  └── Compound goal → ParallelRunner
        ├── Create N tabs via MultiActorSession pattern
        ├── Run sub-goals in parallel (Promise.all)
        ├── EvidenceMerger combines results
        └── Return merged answer as final result
```

### Changes (ordered by impact)

#### 1. GoalDecomposer (src/runner/goal-decomposer.ts) — NEW
- Input: goal string
- Output: `{ type: 'simple' } | { type: 'compound', subGoals: SubGoal[] }`
- SubGoal: `{ goal: string, startUrl?: string, budgetFraction: number }`
- Implementation: 1 cheap LLM call (gpt-4.1-mini, ~200 tokens) that classifies and splits
- Trigger patterns:
  - "compare X vs Y" → 2 sub-goals
  - "find N items matching criteria" → 1 sub-goal with evidence accumulator
  - "X and also Y" → 2 sub-goals
  - Default: simple (no decomposition)

#### 2. ParallelRunner (src/runner/parallel-runner.ts) — NEW
- Takes decomposed sub-goals + browser context
- Creates one Page + PlaywrightDriver + BrowserAgent per sub-goal
- Runs all sub-agents via Promise.all with per-agent timeout
- Collects results and passes to EvidenceMerger
- Budget split: divide token budget evenly across sub-agents

#### 3. EvidenceMerger (src/runner/evidence-merger.ts) — NEW
- Takes N AgentResults from parallel sub-agents
- Merges into one coherent answer
- For comparison goals: structured table of results
- For collection goals: deduplicated list
- Implementation: 1 cheap LLM call to synthesize, or deterministic merge when possible

#### 4. BrowserAgent.run() integration (src/runner/runner.ts) — MODIFY
- At the START of run(), call GoalDecomposer
- If compound: delegate to ParallelRunner, return merged result
- If simple: existing single-page path (zero change)
- The decomposer is a pre-flight check, not a mid-run decision

#### 5. Evidence accumulator for multi-item goals (src/runner/runner.ts) — MODIFY
- For goals like "find 5 restaurants", track items found in structured JSON
- Inject count ("3/5 found so far") into agent context each turn
- Complete when target count reached
- This helps even WITHOUT parallel tabs — single-page multi-item is better tracked

### Alternatives Considered
- **Mid-run decomposition**: detect during execution that the goal needs splitting. Rejected — too complex, hard to test, and the agent might be 10 turns in before realizing.
- **New runner class**: build a CompoundRunner from scratch. Rejected — MultiActorSession already handles the hard part (parallel contexts).
- **Always decompose**: run decomposer on every goal. Rejected — overhead for simple goals, and the LLM call adds latency.

### Risk Assessment
- **Tab lifecycle**: pages can crash, leak memory. Mitigated: timeout per sub-agent, close contexts on completion.
- **Budget fragmentation**: splitting 300k tokens 3 ways = 100k each. Some sub-goals might need more. Mitigated: uneven budget allocation based on complexity.
- **False decomposition**: decomposer splits a goal that shouldn't be split. Mitigated: conservative trigger patterns, simple goals are the default.
- **Rollback**: GoalDecomposer returns `{ type: 'simple' }` = existing behavior. Zero risk to non-compound goals.

### Success Criteria
- Compound task pass rate: 28/34 → 30/34 (flip 2 of the 6 failures)
- Comparison task wall time: -40% (parallel execution)
- Non-compound tasks: zero regression (decomposer returns 'simple', existing path unchanged)
- WebbBench compound tasks: verify works on held-out comparison goals
