# Browser Agent Ops

Canonical operating roadmap for `agent-browser-driver`.

This is the single source of truth for:
- mission
- benchmark policy
- promotion rules
- failure taxonomy
- execution order
- immediate next actions

Use this document for planning and prioritization.
Use [RELIABILITY.md](/Users/drew/webb/agent-browser-driver/RELIABILITY.md) for the day-to-day run loop.
Use [competitor-analysis-2026-03.md](/Users/drew/webb/agent-browser-driver/docs/research/competitor-analysis-2026-03.md) for external reference points.

## Mission

Build a general-purpose browser agent that:
- completes real user tasks reliably
- improves with evidence, not anecdotes
- stays simple enough to operate and evolve quickly

Primary outcomes:
- higher pass rate
- lower median duration
- lower token cost
- complete artifacts on every run

Non-goals:
- optimizing for one demo app at the expense of generality
- shipping features without measurable reliability impact
- mixing product work and research work in the same experiment

## North Star

The system should behave like an eval-driven control loop:
1. measure a stable baseline
2. classify failures
3. fix one high-leverage failure class
4. rerun the same slice
5. promote only when improvement is real

This is RL-style discipline in practice, without pretending we have a full RL stack.

## Tiers

### Tier 1
- deterministic local fixtures
- must stay at 100%

### Tier 2
- authenticated staging core flows
- target 100%

### Tier 3
- public web tasks
- used for capability tracking and generalization
- not allowed to justify regressions in Tier 1 or Tier 2

## Current Direction

Current strategy is correct:
- fix execution bugs first
- fix verifier bugs second
- tune policy only after the measurement loop is trustworthy

Recent high-value wins followed that order:
- popup/new-tab adoption in the driver
- first-party sibling-subdomain verification policy
- script-backed extraction acceptance
- benchmark env/config integrity fixes

This is the pattern to continue.

## Benchmark Policy

### Canonical experiment structure
- fixed scenario slice
- fixed seed
- fixed model
- fixed timeout budget
- one intervention at a time

### Required tracked metrics
- pass rate
- median duration
- turns used
- tokens used
- artifact completeness

### Promotion rule
Promote only when all are true:
- no Tier 1 regression
- no Tier 2 regression
- positive or neutral pass-rate delta on the target slice
- artifact completeness remains intact
- latency/token improvement is meaningful if pass rate is flat

### Parallelism rule
- parallelize inside one experiment first
- do not run multiple unrelated promotion-grade experiments in parallel
- use outer-loop parallel runs only for coarse screening, never for final decisions

## Failure Taxonomy

Every loss should land in one of these buckets:

### 1. Execution bug
The browser/driver does the wrong thing.
Examples:
- popup/new-tab not adopted
- stale selector handling broken
- dead clicks
- storage/auth not applied

Action:
- fix in driver/runtime

### 2. Verifier bug
The agent did the work, but completion was rejected incorrectly.
Examples:
- first-party subdomain mismatch
- script-extracted evidence not accepted
- a11y-only visibility bias

Action:
- make verification policy deterministic

### 3. Policy/path inefficiency
The agent wastes turns but is technically capable.
Examples:
- repeated search reformulations
- excessive backtracking
- late completion after enough evidence exists
- repeated verifier bounce-back loops

Action:
- improve heuristics / system prompt / recovery rules

### 4. Runtime variance / environment instability
The system is correct but unstable under budget.
Examples:
- intermittent first-turn timeout
- provider latency spikes
- anti-bot fluctuations
- noisy public-site dependencies

Action:
- isolate, instrument, and adjust budgets or retry policy

### 5. External blocker
The task is blocked by something the agent should not brute-force through.
Examples:
- captcha
- hard auth wall without credentials
- network unreachable
- domain constraints incompatible with the real site structure

Action:
- classify and stop early

## Operating Rules

1. Do not treat infrastructure failures as agent failures.
2. Do not treat verifier failures as policy failures.
3. Do not run broad new benchmarks before the current slice is stable.
4. Do not promote from one-off wins.
5. Do not mix multiple interventions in one cycle.
6. Prefer deterministic fixes over prompt inflation.
7. Keep wallet/crypto behavior strictly optional and isolated.
8. Keep product-specific hints optional; the agent must remain general-purpose.

## Execution Order

### Phase 1: Measurement Integrity
Goal:
- make results trustworthy

Checklist:
- stable seeded slice
- explicit per-run config capture
- artifact completeness checks
- reproducible memory isolation during experiments
- clear failure taxonomy output

Exit criteria:
- repeated runs are comparable enough to support promotion decisions

### Phase 2: Structural Reliability
Goal:
- remove platform and verifier defects

Checklist:
- popup/new-tab handling
- auth/storage-state correctness
- first-party host policy
- script-backed extraction policy
- terminal blocker fast-fail rules

Exit criteria:
- obvious false negatives and execution traps are gone

### Phase 3: Turn Efficiency
Goal:
- reduce wasted turns and budget burn

Checklist:
- search-result page heuristics
- sufficient-evidence early completion
- bounded recovery for reformulation loops
- earlier extraction on catalog/search/filter pages
- fewer redundant navigations after landing on good pages

Exit criteria:
- median turns and duration drop on the same slice

### Phase 4: Controlled Policy Experiments
Goal:
- compare strategies scientifically

Checklist:
- baseline
- one challenger
- fixed seed/cases/budget
- CI-aware comparison

Possible challengers:
- supervisor variants
- prompt variants
- routing variants
- memory variants

Exit criteria:
- winner beats baseline with enough evidence to promote

### Phase 5: Productization
Goal:
- make the winning path usable in the app

Checklist:
- app -> worker -> orchestrator -> sandbox path
- auth files end-to-end
- artifact upload path
- live run visibility
- clean run reports and video playback
- CI setup path for users

Exit criteria:
- one real authenticated dogfood flow works end to end

### Phase 6: Benchmark Expansion
Goal:
- broaden coverage without losing rigor

Checklist:
- add WebVoyager
- expand WebBench slices
- add owned staging flows
- add optional wallet/crypto suites

Exit criteria:
- breadth increases without losing comparability discipline

## Required Instrumentation

Every serious run should expose:
- first `navigate` timing
- first `observe` timing
- first `decide` timing
- first `execute` timing
- total turns
- repeated-query count
- verifier rejection count
- turns after first sufficient evidence

Without this, we will keep guessing at what is slow.

## Immediate Priorities

### P0
- add first-turn phase timing to reports
- add waste accounting to reports
- rerun the current `reach3` slice repeatedly

### P1
- eliminate the highest-frequency wasted-turn pattern
- stabilize NIH-class search tasks at the target budget

### P2
- only then resume supervisor and policy challenger experiments

## Current Recommendation

Do this next, in order:
1. instrument
2. repeat the same slice
3. fix the top waste class
4. rerun
5. promote only if the delta holds

That is the fastest path to a better browser agent.

