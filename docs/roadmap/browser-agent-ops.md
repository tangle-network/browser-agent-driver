# Browser Agent Ops

Canonical operating roadmap for `agent-browser-driver`.

This is the single planning document for:
- mission
- success criteria
- benchmark policy
- promotion gates
- failure taxonomy
- execution order
- immediate priorities

Use [RELIABILITY.md](/Users/drew/webb/agent-browser-driver/RELIABILITY.md) for the day-to-day run loop.
Use [competitor-analysis-2026-03.md](/Users/drew/webb/agent-browser-driver/docs/research/competitor-analysis-2026-03.md) for external reference points.
Use [README.md](/Users/drew/webb/agent-browser-driver/README.md) for package/API/CLI surface only.

## Mission

Build a general-purpose browser agent that completes real tasks reliably, produces complete artifacts, and improves through controlled measurement instead of anecdotal prompt tuning.

Primary outcomes:
- higher pass rate
- lower median duration
- lower median turns
- lower token cost
- complete artifacts on every run

Non-goals:
- optimizing for one demo app at the expense of generality
- shipping features without measurable reliability impact
- widening benchmark scope before the current slice is stable
- mixing product work and research work in the same experiment

## Success Definition

The system is healthy only when all are true:
- Tier 1 remains at 100%
- Tier 2 trends to 100% through bug closure, not benchmark filtering
- Tier 3 is used to measure generalization, not excuse regressions
- every serious run emits report, manifest, and recording
- promotion decisions are backed by repeated seeded runs

The program is succeeding when we can repeatedly do this loop:
1. measure a clean baseline
2. classify failures correctly
3. fix one high-leverage failure class
4. rerun the same slice
5. promote only when the delta holds

This is an eval-driven control system. Treat it like one.

## Principles

1. Fix execution bugs before policy tuning.
2. Fix verifier bugs before prompt tuning.
3. Treat zero-turn and startup failures as infrastructure until proven otherwise.
4. Change one variable at a time.
5. Prefer deterministic fixes over prompt inflation.
6. Keep product-specific hints optional.
7. Keep wallet and crypto behavior isolated behind explicit flags.
8. Do not call a result real unless the artifacts and config are preserved.

## Target Architecture

Build toward a small layered control system, not a generic framework:
- `actor`: main browser policy loop
- `scout`: cheap recommendation pass on ambiguous link/result pages only
- `verifier`: deterministic completion policy plus LLM verification where needed
- `supervisor`: hard-stall recovery only

Guardrails:
- no new browser action types for scouting
- no broad plugin system
- no default branching everywhere
- vision, branching, and extra compute stay challenger-only until they win repeatedly

## Benchmark Tiers

### Tier 1: Deterministic Fixtures
- local, controlled, repeatable
- must stay at 100%
- blocks merges

### Tier 2: Authenticated Core Flows
- staging or owned environments with credentials
- target is 100%
- used to validate real product flows

### Tier 3: Public Web
- open-web capability and generalization
- expected to be noisy
- cannot justify regressions in Tier 1 or Tier 2

## Benchmark Policy

Promotion-grade experiments must keep these fixed:
- scenario slice
- seed
- model
- timeout budget
- browser mode
- memory policy
- artifact policy

Required metrics:
- pass rate
- median duration
- median turns
- token usage
- artifact completeness
- failure-class distribution

Parallelism policy:
- parallelize inside one experiment first
- do not run multiple unrelated promotion-grade experiments in parallel
- use outer-loop parallelism only for coarse screening, never for final decisions

Memory policy:
- isolate memory per run during benchmark experiments unless memory is the intervention being tested
- never compare contaminated and uncontaminated arms

Model policy:
- product/runtime defaults may advance as newer official models become available
- benchmark controls stay pinned until a slice is intentionally re-baselined
- newer models belong in challenger arms until they beat the fixed control cleanly

## Promotion Gate

Promote only when all are true:
- no Tier 1 regression
- no Tier 2 regression
- target-slice pass rate is positive or neutral
- artifacts remain complete
- failure mix does not shift toward a worse structural class
- if pass rate is flat, duration or token cost improvement is meaningful

Reject or roll back when any are true:
- Tier 1 drops
- Tier 2 drops without an explicit temporary exception
- artifact completeness degrades
- the apparent gain depends on one-off wins or unseeded runs
- the change mixes multiple interventions and cannot be attributed cleanly

## Failure Taxonomy

Every failure must land in one bucket before work is prioritized.

### 1. Execution Bug
The browser or driver does the wrong thing.

Examples:
- popup or new-tab not adopted
- stale selector handling broken
- dead click or type path
- auth state not applied
- incorrect browser storage/session setup

Action:
- fix the runtime or driver

### 2. Verifier Bug
The agent did the work, but completion was rejected incorrectly.

Examples:
- first-party sibling-subdomain mismatch
- script-extracted evidence ignored
- a11y-only visibility bias
- correct answer rejected because the checker was too narrow

Action:
- make verification policy deterministic

### 3. Policy or Path Inefficiency
The agent is capable, but wastes turns.

Examples:
- repeated search reformulations
- excessive backtracking
- late completion after enough evidence exists
- repeated verifier bounce-back loops
- unnecessary navigation after landing on the right page

Action:
- add heuristics, recovery rules, or prompt changes only after structural causes are ruled out

### 4. Runtime Variance or Environment Instability
The system is correct but unstable under budget.

Examples:
- intermittent first-turn timeout
- provider latency spikes
- anti-bot variance
- noisy public-site dependencies
- rate-limit or quota instability

Action:
- instrument, isolate, and adjust budget or retry policy

### 5. External Blocker
The task should stop early rather than brute-force through a dead end.

Examples:
- captcha
- hard auth wall without credentials
- network unreachable
- domain constraints incompatible with the live site

Action:
- classify and stop early

## Required Instrumentation

Every promotion-grade run must expose:
- first `navigate` timing
- first `observe` timing
- first `decide` timing
- first `execute` timing
- total turns
- repeated-query count
- verifier rejection count
- turns after first sufficient evidence
- final failure class
- report, manifest, and recording paths

Without this, optimization work is guesswork.

## Definition Of Done For A Reliability Change

A change is not done when code compiles. It is done when all are true:
- the failure class is explicitly identified
- the fix is scoped to that class
- tests cover the regression where practical
- the same seeded slice is rerun
- results are attributable to the one change
- artifacts are preserved
- the promotion gate is passed or the change remains flagged

## Execution Phases

### Phase 1: Measurement Integrity
Goal:
- make results trustworthy

Checklist:
- stable seeded slice
- explicit per-run config capture
- artifact completeness checks
- reproducible memory isolation
- clear failure taxonomy output
- first-turn phase timing in reports

Exit criteria:
- repeated runs are comparable enough to support promotion decisions

### Phase 2: Structural Reliability
Goal:
- remove runtime and verifier defects that create false failures

Checklist:
- popup and new-tab handling
- auth and storage-state correctness
- first-party host policy
- script-backed extraction policy
- terminal blocker fast-fail rules
- startup and zero-turn failure classification

Exit criteria:
- obvious false negatives and execution traps are gone

### Phase 3: Turn Efficiency
Goal:
- reduce wasted turns and budget burn

Checklist:
- search-result page heuristics
- cheap `scout` recommendations on ambiguous visible-link/result pages
- sufficient-evidence early completion
- bounded recovery for reformulation loops
- earlier extraction on search, catalog, and filter pages
- fewer redundant navigations after landing on good pages
- waste accounting in every report

Exit criteria:
- median turns and duration drop on the same slice without pass-rate loss

### Phase 4: Structured Policy
Goal:
- improve path choice without turning the codebase into a generic orchestration framework

Checklist:
- keep `actor` as the main loop
- add `scout` only as a narrow ambiguous-page recommendation pass
- keep `verifier` deterministic-first
- keep `supervisor` recovery-only
- keep branching and extra compute behind explicit challengers

Exit criteria:
- path quality improves on repeated slices
- architecture remains small, testable, and debuggable

### Phase 5: Controlled Policy Experiments
Goal:
- compare strategies scientifically

Checklist:
- one baseline
- one challenger
- fixed seed, cases, and budget
- CI-aware comparison
- rollback path defined before promotion

Possible challengers:
- supervisor variants
- prompt variants
- routing variants
- memory variants
- bounded branch exploration variants

Exit criteria:
- the winner beats baseline with enough evidence to promote

### Phase 6: Productization
Goal:
- make the winning path usable end to end

Checklist:
- app to worker to orchestrator to sandbox execution path
- auth files end to end
- artifact upload path
- live run visibility
- clean run reports and video playback
- CI setup path for users

Exit criteria:
- one real authenticated dogfood flow works end to end with artifacts

### Phase 7: Benchmark Expansion
Goal:
- broaden coverage without losing rigor

Checklist:
- add WebVoyager
- expand WebBench slices
- add owned staging flows
- add optional wallet and crypto suites behind flags

Exit criteria:
- breadth increases without losing comparability discipline

## Operating Cadence

### Per Change
1. classify the failure
2. define the narrowest fix
3. add or update tests
4. rerun the same seeded slice
5. compare against control
6. promote, flag, or revert

### Daily
1. run Tier 1 and Tier 2 control baselines
2. aggregate failures by class
3. fix the highest-frequency structural issue first
4. rerun baseline

### Weekly
1. review pass rate, duration, turns, and cost trends
2. review top failure classes
3. decide the next single intervention
4. retire dead-end experiments

## Current Program

### Current Assessment
The direction is correct:
- execution bugs were being misread as agent weakness
- verifier bugs were being misread as policy weakness
- benchmark integrity needed hardening before meaningful supervisor or prompt work

Recent wins that fit this model:
- popup and new-tab adoption
- first-party sibling-subdomain verification policy
- script-backed extraction acceptance
- `.env` and benchmark config integrity fixes

### Delivery Tracker

This is the canonical finish-line tracker. Work is done only when every item here is complete and verified.

| Track | Status | Done when | Verification |
| --- | --- | --- | --- |
| Tier 1 deterministic fixtures | Verified baseline | Stable at 100% on repeated local runs | `npm run bench:tier1:gate` |
| Tier 2 authenticated core flows | Verified baseline | Stable at 100% with real auth state and complete artifacts across repeated runs | `npm run bench:tier2:repeat -- --storage-state ./.auth/ai-tangle-tools.json` |
| Tier 3 public-web `reach3` baseline | Verified baseline | At least 5 repeated seeded runs with no case below 80% pass and no structural false-positive class open | `npm run bench:tier3:gate -- --existing-root ./agent-results/reach3-contenthub-v4-repeat-1772786885` |
| Search/domain policy correctness | Verified baseline | Disallowed-host clicks and false-positive completions are blocked deterministically | repeated NIH runs + targeted tests |
| Artifact completeness | Verified baseline | Every serious run emits report, manifest, and recording | artifact completeness checks in baseline/gate summaries |
| Cost and turn efficiency | In progress | Median turns, duration, and token cost are non-regressive on the promoted slice | repeated baseline summaries |
| Vision challenger | In progress | Vision-based policy must beat or match the baseline on repeated seeded runs before promotion | challenger-only repeated runs; not baseline |
| Product path readiness | Pending | Winning execution path is wired cleanly into app -> worker -> orchestrator -> artifacts | end-to-end dogfood run with video/report |

### Current Scoreboard

This section is an operational snapshot, not roadmap authority. Keep policy and target architecture above stable; refresh or prune this section as the measured state changes.

Current honest status:
- Tier 1 deterministic control is green on the promoted local fixture set
- repeated `reach3` control is now green across 5 repeated runs
- current repeated control sample: Yale `5/5`, Alberta `5/5`, NIH `5/5`
- Tier 3 is now good enough to support promotion decisions on this slice
- selective `auto` vision is currently a challenger only; it regressed on NIH and is not baseline-ready
- NIH token burn has been reduced on focused post-fix repeats, though broader Tier 3 efficiency work remains open
- Tier 2 repeated authenticated control is now green across three valid repetitions
- the Tier 2 Coinbase template-verification fast-explore regression has been corrected on post-fix repeats; it no longer needs to launch runs or over-prove actionability to satisfy the goal

Current best evidence:
- Tier 1 deterministic summary: `./agent-results/tier1-green-1772794410/tier1-gate-summary.json`
- Tier 1 deterministic markdown: `./agent-results/tier1-green-1772794410/tier1-gate-summary.md`
- clean corrected `reach3`: `./agent-results/reach3-contenthub-v4-1772786683/track-summary.json`
- repeated `reach3`: `./agent-results/reach3-contenthub-v4-repeat-1772786885/`
- executable Tier 3 summary: `./agent-results/reach3-contenthub-v4-repeat-1772786885/tier3-gate-summary.json`
- Tier 2 repeated authenticated summary: `./agent-results/tier2-repeat-green-1772792440/tier2-repeat-summary.json`
- Tier 2 repeated authenticated markdown: `./agent-results/tier2-repeat-green-1772792440/tier2-repeat-summary.md`
- Tier 2 post-fix template verification summary: `./agent-results/tier2-repeat-post-template-fix-1772794740/tier2-repeat-summary.json`
- NIH post-fix focused summary: `./agent-results/nih-token-fix-repeat-1772795250/tier3-gate-summary.json`
- Tier 2 validated repetition summaries:
  - `./agent-results/tier2-repeat-green-1772792440/rep-1/tier2-gate-summary.json`
  - `./agent-results/tier2-repeat-green-1772792440/rep-2/tier2-gate-summary.json`
  - `./agent-results/tier2-repeat-green-1772792440/rep-3/tier2-gate-summary.json`
- repeated control medians:
  - Yale (`webbench-2204`): `5/5`, median `28.9s`, median `5` turns, median `27.2k` tokens
  - NIH (`webbench-2605`): `5/5`, median `77.9s`, median `12` turns, median `185.8k` tokens
  - Alberta (`webbench-32`): `5/5`, median `50.2s`, median `7` turns, median `56.3k` tokens

Exit rule:
- do not call the browser agent production-ready until Tier 1 is green, Tier 2 is green, and repeated Tier 3 control runs are stable enough to support promotion decisions

### Immediate Priorities

P0:
- keep the guarded non-vision path as baseline until a challenger beats it cleanly
- verify the Tier 2 template-verification cost fix continues to hold in CI/nightly, then allow `fast-explore` to remain first-class on authenticated flows
- close product path readiness with one clean end-to-end app -> worker -> orchestrator -> artifact dogfood run

P1:
- continue reducing Tier 3 cost variance, especially NIH, on the promoted slice
- reduce wasted-turn variance on Yale and Alberta after NIH is stable
- raise Tier 2 authenticated coverage with the same artifact standards
- reduce `fast-explore` cost and turn variance on authenticated template verification before considering it a Tier 2 default
- keep Tier 2 repeated gate and Tier 3 public gate healthy in CI

P2:
- resume supervisor and policy challenger experiments only after the slice is stable
- keep vision as a challenger until it shows repeated non-regressive gains
- wire the winning execution path cleanly into the app stack

Candidate experiments to queue after the current slice is stable:
- bounded branch exploration at high-ambiguity points only
- branch count capped at 2 to 3
- short horizon only (1 to 3 actions per branch)
- use read-mostly scouting before side-effectful actions
- score and prune aggressively; continue only the winning branch
- never make this default until it proves non-regressive on cost and pass rate

## Do And Do Not

Do:
- keep the current slice small until it is trustworthy
- bias toward deterministic fixes
- preserve artifacts for every serious run
- use repeated seeded experiments for decisions

Do not:
- widen scope because one case passed once
- run many promotion-grade experiments in parallel
- mix product features with benchmark research in one change
- use open-web noise to excuse Tier 1 or Tier 2 regressions
- promote on narrative instead of evidence

## Short-Term Execution Plan

This is the next sequence to execute:
1. implement phase timing and waste accounting
2. rerun the same `reach3` slice for repeated baselines
3. identify the top remaining failure class
4. ship the smallest fix that addresses that class
5. rerun and decide promotion from evidence only

That is the fastest path to a meaningfully better browser agent.
