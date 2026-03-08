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
| Tier 3 public-web `reach3` baseline | Verified baseline | At least 5 repeated seeded runs with no case below 80% pass and no structural false-positive class open | `npm run bench:tier3:gate -- --existing-root ./agent-results/tier3-gate-visible-release-1772847117` |
| Search/domain policy correctness | Verified baseline | Disallowed-host clicks and false-positive completions are blocked deterministically | repeated NIH runs + targeted tests |
| Artifact completeness | Verified baseline | Every serious run emits report, manifest, and recording | artifact completeness checks in baseline/gate summaries |
| Cost and turn efficiency | In progress | Median turns, duration, and token cost are non-regressive on the promoted slice | repeated baseline summaries |
| Vision challenger | In progress | Vision-based policy must beat or match the baseline on repeated seeded runs before promotion | challenger-only repeated runs; not baseline |
| Product path readiness | Verified baseline | Winning execution path is wired cleanly into app -> worker -> orchestrator -> artifacts | verified local dogfood in `abd-app`: `npm --prefix worker run e2e:real-ui` |

### Current Scoreboard

This section is an operational snapshot, not roadmap authority. Keep policy and target architecture above stable; refresh or prune this section as the measured state changes.

Current honest status:
- Tier 1 deterministic control is green on the promoted local fixture set
- **FULL WEBBENCH-50: 34/50 (68%) stealth, 33/50 (66%) stealth+fixes, 39/50 (78%) union**
  - Non-stealth baseline: 19/50 (38%) → stealth mode is the #1 improvement (+30pp)
  - 3-rep stability run pending for proper median score
- Tier 2 repeated authenticated control is green across three valid repetitions
- `openai/gpt-5.4` remains the promoted default runtime
- `webbench-stealth` is the recommended profile for Tier 3 benchmarks
- key systemic fixes:
  - stealth profile: headed mode + anti-detection flags + minimal resource blocking
  - navigator property patching: plugins, languages, hardwareConcurrency, deviceMemory, chrome.runtime
  - domain constraint relaxation: registrable domain matching (fixes subdomain redirects)
  - progressive acceptance: Tier A (0.55 + evidence after 1 rejection), Tier B (0.50 after 2 rejections)
  - URL mapping fix in track script: `scenario.url` fallback saves 2 turns/run
  - evidence limit 3→5, verifier supplemental evidence trust, content discovery rule
  - prioritized snapshot budgeting, extraction guard, search auto-submit
- remaining failures (11 never-passed):
  - hard anti-bot (3): Cambridge (Cloudflare), Crunchbase (Cloudflare), Dreamstime (verification gate)
  - site/content issues (5): Goal.com, MakeMyTrip, USDA, AllTrails, Sky Sports
  - stochastic/close (3): ASOS, PRNewswire, Groupon — may flip with more runs
- `scout` remains challenger-only; not promoted

Current best evidence:
- Tier 1 deterministic summary: `./agent-results/tier1-green-1772794410/tier1-gate-summary.json`
- Tier 1 deterministic markdown: `./agent-results/tier1-green-1772794410/tier1-gate-summary.md`
- clean corrected `reach3`: `./agent-results/reach3-contenthub-v4-1772786683/track-summary.json`
- current promoted repeated `reach3`: `./agent-results/tier3-gate-visible-release-1772847117/`
- current promoted Tier 3 summary: `./agent-results/tier3-gate-visible-release-1772847117/tier3-gate-summary.json`
- current promoted Tier 3 markdown: `./agent-results/tier3-gate-visible-release-1772847117/tier3-gate-summary.md`
- Tier 2 repeated authenticated summary: `./agent-results/tier2-repeat-green-1772792440/tier2-repeat-summary.json`
- Tier 2 repeated authenticated markdown: `./agent-results/tier2-repeat-green-1772792440/tier2-repeat-summary.md`
- Tier 2 post-fix template verification summary: `./agent-results/tier2-repeat-post-template-fix-1772794740/tier2-repeat-summary.json`
- NIH post-fix focused summary: `./agent-results/nih-token-fix-repeat-1772795250/tier3-gate-summary.json`
- local product-path evidence lives in `abd-app`: `/tmp/abd-real-ui-e2e-gate-1772826110/`
- provider screen, OpenAI control: `./agent-results/provider-openai-gpt54-reach3-1772840341/track-summary.json`
- provider screen, Codex challenger: `./agent-results/provider-codex-gpt54-reach3-1772840486/track-summary.json`
- focused NIH correctness + cost pass: `./agent-results/nih-visible-release-1772847031/baseline-summary.json`
- older guarded `reach3`: `./agent-results/reach3-content-guard-v2-1772842574/track-summary.json`
- wider sanity slice on the current baseline: `./agent-results/webbench-sanity6-1772848273/track-summary.json`
- anti-bot reach challenger on Crunchyroll: `./agent-results/crunchyroll-webbench-stealth-1772849365/report.json`
- anti-bot reach challenger on APKPure: `./agent-results/apkpure-webbench-stealth-1772849425/report.json`
- top-2 branch challenger NIH smoke: `./agent-results/nih-top2-branch-smoke-1772843605/baseline-summary.json`
- top-2 branch challenger `reach3`: `./agent-results/reach3-top2-branch-1772843662/track-summary.json`
- Tier 2 validated repetition summaries:
  - `./agent-results/tier2-repeat-green-1772792440/rep-1/tier2-gate-summary.json`
  - `./agent-results/tier2-repeat-green-1772792440/rep-2/tier2-gate-summary.json`
  - `./agent-results/tier2-repeat-green-1772792440/rep-3/tier2-gate-summary.json`
- current promoted repeated control medians:
  - Yale (`webbench-2204`): `5/5`, median `19.4s`, median `4` turns, median `18.5k` tokens
  - NIH (`webbench-2605`): `5/5`, median `57.0s`, median `11` turns, median `153.1k` tokens
  - Alberta (`webbench-32`): `5/5`, median `37.5s`, median `7` turns, median `54.5k` tokens
- latest provider screen on the guarded `reach3` slice:
  - OpenAI `gpt-5.4`: Yale pass `19.1s` / `4` turns / `18.6k`; NIH pass `53.8s` / `11` turns / `133.9k`; Alberta pass `47.2s` / `8` turns / `74.0k`
  - Codex CLI `gpt-5.4`: Yale pass `45.5s` / `4` turns / `51.4k`; NIH fail `120.0s` / `9` turns / `178.5k`; Alberta pass `93.4s` / `7` turns / `113.4k`
- latest honest guarded baseline:
  - Yale (`webbench-2204`): pass `22.8s` / `4` turns / `18.6k`
  - NIH (`webbench-2605`): pass `66.9s` / `12` turns / `153.4k` on `https://www.nih.gov/news-events/news-releases/...`
  - Alberta (`webbench-32`): pass `49.6s` / `8` turns / `74.1k`
- current promoted repeated baseline:
  - Yale (`webbench-2204`): `5/5`, median `19.4s` / `4` turns / `18.5k`
  - NIH (`webbench-2605`): `5/5`, median `57.0s` / `11` turns / `153.1k`
  - Alberta (`webbench-32`): `5/5`, median `37.5s` / `7` turns / `54.5k`
- top-2 branch challenger:
  - focused NIH smoke: pass `41.8s` / `9` turns / `83.2k`
  - full `reach3`: Yale improved, Alberta improved, NIH regressed to timeout; do not promote
- cookie-fix verification (post-fix baseline):
  - Tier 1 gate: PASS (100%)
  - reach3 regression check: Yale pass `18.2s` / `4` turns / `16.4k`; NIH pass `65.5s` / `13` turns / `184.8k`; Alberta pass `36.3s` / `7` turns / `47.4k`
  - John Lewis focused: pass `53.7s` / `4` turns / `32.9k`
- stealth reach5 baseline (`benchmark-webbench-stealth` + cookie fix):
  - Crunchyroll: pass `14.1s` / `3` turns / `11.5k`
  - APKPure: fail (timeout, search-field a11y issue)
  - John Lewis: pass `49.3s` / `4` turns / `33.0k`
  - Target: fail (timeout, path inefficiency)
  - Best Buy: pass `96.2s` / `9` turns / `237.3k`
- stealth reach5 v3 (oscillation fix + snapshot budget + action timeout):
  - Crunchyroll: pass `18.4s` / `3` turns / `13.5k`
  - APKPure: pass `92.1s` / `9` turns / `243.9k`
  - John Lewis: pass `42.8s` / `4` turns / `26.8k`
  - Target: pass `78.5s` / `5` turns / `37.0k`
  - Best Buy: pass `26.7s` / `3` turns / `101.7k`
  - result: 5/5 (100%) — up from 3/5 (60%)
- reach3 with search auto-submit + verification escalation (2 reps):
  - rep1: Yale pass `4` turns / `26k`; NIH pass `13` turns / `217k`; Alberta pass `11` turns / `151k`
  - rep2: Yale pass `15` turns / `191k`; NIH pass `9` turns / `120k`; Alberta pass `9` turns / `98k`
  - result: 3/3 (100%) × 2 reps — NIH was previously ~62% (5/8), now 100% (4/4 counting both NIH-only and full runs)
- reach4 with expert-level improvements (budget pressure + extraction guard + same-page snapshot):
  - Yale: pass `5` turns / `36k`
  - NIH: pass `11` turns / `170k`
  - Alberta: pass `8` turns / `76k`
  - Encyclopedia.com: pass `6` turns / `61k` (was 25-turn timeout / 564k)
  - result: 4/4 (100%) — encyclopedia.com unlocked by extraction guard

Exit rule:
- do not call the browser agent production-ready until Tier 1 is green, Tier 2 is green, and repeated Tier 3 control runs are stable enough to support promotion decisions

### Immediate Priorities

P0:
- keep the guarded non-vision path as baseline until a challenger beats it cleanly
- keep `openai/gpt-5.4` as the promoted default runtime; do not switch the baseline to `codex-cli` unless it wins on the fixed slice
- verify the Tier 2 template-verification cost fix continues to hold in CI/nightly, then allow `fast-explore` to remain first-class on authenticated flows
- keep product-path readiness green in `abd-app` CI and hosted gates
- preserve the new content-type guard; do not accept public-web “wins” that land on the wrong content class

P1:
- ~~continue reducing Tier 3 cost variance, especially NIH, on the promoted slice~~ — resolved: search auto-submit + verification escalation brought NIH from ~62% to 100% across 4 consecutive runs
- reduce wasted-turn variance on Yale and Alberta after NIH is stable
- run repeated seeded stealth reach5 experiments to build promotion-grade evidence for the reach challenger
- ~~fix APKPure search-field a11y detection~~ — resolved: action timeout scaling (15s for 120s cases) prevents stuck clicks from consuming the entire budget
- ~~fix Target path inefficiency~~ — resolved: oscillating stuck detection (A-B-A-B pattern) breaks menu open/close loops
- ~~reduce Best Buy token cost~~ — resolved: snapshot budget cap (16k chars, interactive-first filtering) reduced 237k → 102k tokens
- stabilize stealth reach5 at 100% across repeated seeded runs before promotion
- raise Tier 2 authenticated coverage with the same artifact standards
- reduce `fast-explore` cost and turn variance on authenticated template verification before considering it a Tier 2 default
- keep Tier 2 repeated gate and Tier 3 public gate healthy in CI
- improve the guarded search/content path before promoting any new subagent policy
- use the top-2 branch challenger only as a measured experiment until it beats the guarded baseline on repeated seeded runs

P2:
- resume supervisor and policy challenger experiments only after the slice is stable
- keep vision as a challenger until it shows repeated non-regressive gains
- continue `scout` only as a challenger until it beats the guarded baseline on repeated seeded runs

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
