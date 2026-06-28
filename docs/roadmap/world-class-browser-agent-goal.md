# World-Class Browser Agent Goal

## North Star

Build `browser-agent-driver` into the simplest powerful browser-agent harness in the field:

- a small action kernel the model can reason about cleanly
- a code-native execution path when code is the right abstraction
- exhaustive step-level observability for cost, latency, tokens, tool calls, tool results, and failures
- benchmark discipline strong enough that every improvement can be trusted
- product-grade reliability on real authenticated browser work, not only frozen demos

The target state is not "more features". The target state is a smaller, sharper machine that can prove what it did, why it did it, what it cost, how long it took, and where it failed.

## One-Sentence Goal

Make `bad` the browser-agent harness that senior engineers trust when the task matters: fast, inspectable, reproducible, low-noise, hard to fool, and easy to improve because every step is measured.

## Current Strengths To Preserve

- The runner already has a real control loop in `src/runner/runner.ts`.
- The driver already exposes Playwright-backed browser actions in `src/drivers/playwright.ts`.
- The action surface already includes high-leverage verbs such as `fill`, `clickSequence`, `runScript`, `extractWithIndex`, and `fanOut` in `src/types/actions.ts`.
- The snapshot path already has a CDP fast path in `src/drivers/cdp-snapshot.ts`.
- Snapshot budgeting already exists in `src/brain/snapshot-budget.ts`.
- Replay, deterministic pattern skips, and decision caching already reduce LLM calls in `src/runner/replay/` and `src/runner/decision-cache.ts`.
- The repo already has hard measurement discipline in `docs/EVAL-RIGOR.md`.
- Competitive evaluation already exists in `docs/COMPETITIVE-EVAL.md` and `bench/competitive/`.

The work is not a restart. It is a convergence project.

## Design Doctrine

### Simplicity Is The Power Source

Simplicity here does not mean fewer capabilities. It means fewer concepts the model and engineer must hold at once.

Good simplicity:

- one browser state format
- one event stream
- one cost model
- one trace format
- one promotion gate
- one small set of composable actions
- one clear fallback path when a shortcut fails

Bad simplicity:

- hiding uncertainty
- removing observability
- collapsing different failure modes into "failed"
- pretending one benchmark score proves generality
- replacing well-tested deterministic logic with prompt hope

### Small Kernel, Rich Traces

The runtime should be compact. The trace should be exhaustive.

The agent loop should feel like this:

```text
observe -> decide -> execute -> verify -> record -> learn -> continue
```

Every arrow must produce structured data.

### Code-Native When It Wins

LLMs understand JavaScript and Playwright-shaped APIs. We should test a code-native actor, but not as a faith-based rewrite.

The rule:

- action JSON remains the stable control path
- a code-native REPL actor becomes a challenger
- promotion requires pass-rate neutrality or gain plus lower cost, lower latency, or lower complexity

### Benchmark Claims Must Be Boring

If a claim is true, it should survive repeated seeded runs.

No single-run speed claims. No stale baselines. No mixed model/harness comparisons pretending to be architecture conclusions.

## Ultimate Architecture

```text
                 +------------------------------+
                 |          bad CLI / SDK        |
                 +---------------+--------------+
                                 |
                                 v
                 +---------------+--------------+
                 |        Run Orchestrator       |
                 | config, budget, artifacts     |
                 +---------------+--------------+
                                 |
          +----------------------+----------------------+
          |                                             |
          v                                             v
+---------+----------+                       +----------+---------+
|  Actor Kernel      |                       | Observability Bus  |
| observe/decide/    |---------------------->| spans, events,     |
| execute/verify     | every step            | metrics, artifacts |
+---------+----------+                       +----------+---------+
          |                                             |
          v                                             v
+---------+----------+                       +----------+---------+
| Browser Driver     |                       | Optimization Store |
| Playwright facade, |                       | traces, summaries, |
| CDP snapshot, CUA  |                       | eval comparisons   |
+---------+----------+                       +----------+---------+
          |
          v
+---------+----------+
| Real Browser       |
| auth, tabs, pages, |
| downloads, popups  |
+--------------------+
```

## Target Runtime Kernel

The final kernel should have exactly these conceptual surfaces:

1. `observe`
   - returns URL, title, compact a11y tree, visible browser events, optional screenshot, and snapshot metrics
   - never dumps raw DOM by default
   - marks focus, clickable state, iframe identity, disabled state, and viewport visibility

2. `decide`
   - consumes current state, goal, bounded history, budget, and recent events
   - emits one typed action, optional safe follow-ups, expected effect, and confidence
   - records full token and latency details

3. `execute`
   - performs a typed action or bounded JS command
   - returns success, result summary, changed state hints, browser events, error class, and retry info

4. `verify`
   - checks expected effect and goal completion
   - distinguishes action failure, verifier failure, policy failure, external blocker, and environment variance

5. `record`
   - writes one canonical span for every observe, decide, execute, verify, model call, tool call, and recovery

6. `optimize`
   - uses traces to identify waste and run controlled experiments
   - never promotes a change without the repo's rigor gates

## Observability Goal

Every run should be reconstructable from structured data without reading console logs.

### Required Span Schema

Every sub-step span must include:

- `runId`
- `sessionId`
- `parentRunId`
- `turn`
- `phase`
- `spanId`
- `parentSpanId`
- `startedAt`
- `endedAt`
- `durationMs`
- `status`
- `errorClass`
- `errorMessage`
- `provider`
- `model`
- `requestId`
- `inputTokens`
- `outputTokens`
- `cachedInputTokens`
- `cacheCreationInputTokens`
- `estimatedCostUsd`
- `toolName`
- `toolArgsHash`
- `toolArgsPreview`
- `toolResultHash`
- `toolResultPreview`
- `snapshotBytes`
- `screenshotBytes`
- `url`
- `title`
- `action`
- `expectedEffect`
- `verificationVerdict`
- `retryAttempt`
- `budgetBefore`
- `budgetAfter`
- `artifacts`

### Required Aggregates

Every run summary must expose:

- pass/fail
- final failure class
- total wall time
- time by phase
- model calls by role
- tool calls by action type
- tokens in, out, cached, and total
- cost by phase and by role
- retries by phase
- verifier rejections
- turns after first sufficient evidence
- repeated query count
- snapshot truncation count
- screenshot count and bytes
- replay hit rate
- decision cache hit rate
- deterministic pattern skip rate
- macro/fan-out usage
- external blocker count

### Observability Principle

If we cannot plot it, compare it, and trace it to a line of behavior, we do not optimize it.

## Skill Operating System

Use the skills as a disciplined workflow, not as vibes.

| Skill | When To Use | Output |
|---|---|---|
| `plan` | Define a major direction or architecture phase | Written implementation plan with tradeoffs |
| `pursue` | Build a coherent next-generation architecture slice | One integrated implementation, not scattered tweaks |
| `evolve` | Optimize a measurable target through experiments | Baseline, challenger, repeated validation |
| `diagnose` | Cluster failures from evals or CI | Ranked root causes and fix hypotheses |
| `autopsy` | Explain a surprising benchmark or eval result | Verified cause, not speculation |
| `harden` | Attack the implementation after it works | New invariants, fuzz cases, adversarial tests |
| `critical-audit` | Review a diff before promotion | P1/P2/P3 findings and verdict |
| `verify` | Confirm completion before claiming done | Tests, status, artifacts, residual risk |
| `ui-test` | Validate browser-facing UI or viewer changes | Browser QA with screenshots and failures |
| `semgrep` | Security pass on execution, auth, or sandbox changes | Static analysis findings |
| `handoff` | Preserve context after major work | Next-session brief |

### Skill Loop For Major Work

```text
plan -> pursue -> verify -> critical-audit -> evolve -> diagnose -> harden -> verify
```

### Skill Loop For Measurement Work

```text
plan -> evolve -> diagnose -> autopsy -> evolve -> verify
```

### Skill Loop For Release Work

```text
verify -> critical-audit -> converge or ship -> deploy-proof when applicable
```

### Context And Delegation Discipline

This project should improve under tight context budgets.

- keep screenshots, videos, full traces, DOM dumps, and raw provider payloads on disk
- pass summaries, metrics, hashes, and file paths through the model context
- dispatch subagents for independent audits: telemetry surface, eval substrate, failure taxonomy, prompt-minimality, and actor-mode design
- require subagent outputs to cite files and line numbers instead of pasting bulky artifacts
- use axLLM / agent-eval analysts for repeatable judgment loops, but store findings as structured artifacts
- never promote an RLM or judge result unless the underlying run has trace integrity and real-backend proof
- close the loop through code and scorecards, not chat transcripts

### Agent-Eval Adoption Gate

`agent-eval` is the canonical eval substrate, but dependency hygiene comes before imports.

Started:

- `@tangle-network/agent-eval` is pinned to `0.100.0`
- `tests/agent-eval-surface.test.ts` verifies the root, `analyst`, `traces`, and `rl` export surfaces before deeper runtime wiring
- `bench/agent-eval/run-records.ts` converts compact `agent-run` telemetry into `validateRunRecord`-checked `RunRecord`s with optional profile-cell identity

Before wiring runtime code to `@tangle-network/agent-eval`:

- pin and install an exact version with the required public surface
- reconcile package-manager lock drift
- audit exports for `AgentProfile`, `agentProfileHash`, `RunRecord`, `validateRunRecord`, `runEvalCampaign`, `assertRealBackend`, `HeldOutGate`, `RawProviderSink`, `TraceEmitter`, `assertRunCaptured`, `AnalystRegistry`, and `MultiLayerVerifier`
- use `runEvalCampaign` for new campaigns when possible
- call `assertRealBackend(runs, { allowMixed: false })` before scoring, scorecard writes, or promotion gates
- require raw provider capture and trace capture integrity before treating a benchmark result as real

## Phase 0: Define The Scoreboard

Goal:

- establish one canonical scoreboard that decides whether the harness is improving

Work:

- make `bench:validate`, `ab:experiment`, `research:pipeline`, and `bench:compete` emit the same metric vocabulary
- normalize cost, token, latency, pass-rate, and failure-class fields
- add a single comparison renderer that can read all four outputs
- require every major PR to paste the same table shape already defined in `docs/EVAL-RIGOR.md`

Done when:

- every benchmark path can answer "what got better, what got worse, and how confident are we?"

## Phase 1: Full-Fidelity Step Observability

Goal:

- instrument every step without changing agent behavior

Started:

- `agent-step` fleet telemetry now bridges the runner event bus into compact JSONL envelopes
- step rows include deterministic span IDs and parent span IDs for trace joins
- `agent-run` summaries now aggregate model calls, tool calls, phase latency, tokens, estimated cost, skips, failures, verification rejections, screenshots, snapshots, and action/model/error counts
- `telemetry:rollup` now surfaces agent-run cost, token, model-call, tool-call, skip, failure, and rejection metrics in JSON and CLI output
- `telemetry:rollup` now flags incomplete or untrustworthy agent telemetry, including missing run summaries, missing steps, missing boundaries, no model usage, and failed runs without reasons
- `telemetry:rollup --fail-on-agent-integrity` now turns those findings into an opt-in fail-closed promotion gate
- model-call events carry token, cache, model, latency, and estimated cost metrics when available
- failed planner calls now emit failed `plan-completed` spans with model, token, latency, and parse/validation failure metadata
- action previews are bounded and privacy-preserving; full args/results are represented by hashes
- screenshots and snapshots stay out of telemetry rows; only sizes and hashes/previews are recorded

Work:

- extend `src/runner/events.ts` from event stream to span stream
- add span IDs and parent span IDs
- emit spans for observe, decide, model call, execute, verify, recovery, replay, planner, fan-out, and supervisor
- include token and cost fields on every model span
- include action result previews on every tool span
- preserve privacy by hashing full args/results and storing bounded previews
- write one canonical `trace.jsonl` per run alongside existing events

Done when:

- a failed run can be debugged from `trace.jsonl` without rerunning it
- aggregate reports can compute cost, latency, and token totals from spans alone

## Phase 2: Simplify The Action Kernel

Goal:

- reduce conceptual load while keeping capability

Work:

- audit every action in `src/types/actions.ts`
- classify each as primitive, compound, recovery, or orchestration
- keep primitives tiny: click, type, press, select, scroll, navigate, wait, script, complete, abort
- keep compound actions only when they remove meaningful turn count: fill, clickSequence, fanOut
- move niche behavior out of the prompt and into deterministic helpers or triggered snippets
- make unsupported actions fail closed with useful errors

Done when:

- prompt action docs shrink
- action errors become more specific
- existing Tier 1 stays green

## Phase 3: Minimal Prompt Program

Goal:

- replace rule sprawl with a compact prompt plus triggered context

Work:

- measure current prompt size by provider and mode
- create a `minimal-system` challenger
- move search, extraction, heavy page, date picker, and blocker rules behind exact triggers
- delete rules that duplicate deterministic code
- evaluate JSON parse rate, turns, pass rate, cost, and verifier rejections

Done when:

- the default prompt is smaller without pass-rate regression
- triggered rules explain why they were included in the trace

## Phase 4: Code-Native Actor Challenger

Goal:

- test the Aside-style hypothesis honestly: a Playwright-shaped JS actor may let the model express richer logic with fewer prompt rules

Work:

- add a gated `actorMode: "action-json" | "js-repl"` config
- expose a small typed browser facade, not raw unlimited page access
- allow bounded JS snippets to call safe methods such as `click(ref)`, `type(ref, text)`, `extract(query)`, `links()`, `snapshot()`, and `complete(result)`
- enforce timeouts, domain policy, argument logging, result size caps, and no secret exfiltration
- record each JS command as a tool span with code hash, preview, result hash, result preview, duration, and error class
- compare against the current actor on extraction, long-horizon, forms, and search tasks

Done when:

- the JS actor either proves a measurable win or is rejected with clear evidence

## Phase 5: Snapshot And Browser Signal Upgrade

Goal:

- make observations smaller, richer, and less lossy

Work:

- extend `src/drivers/cdp-snapshot.ts` to include focus state, clickable state, disabled state, iframe identity, viewport visibility, and bounding hints
- preserve the current ref contract so existing actions keep working
- add browser event steering: popup opened, download started, download completed, tab opened, tab closed, navigation failed, permission prompt, file chooser
- summarize events into the next decision context
- measure snapshot bytes and truncation rate per turn

Done when:

- fewer model turns are spent discovering state the browser already knew

## Phase 6: Viewport And CUA Stability

Goal:

- make visual fallback stable and benchmark-comparable

Work:

- add a `benchmark-1440x900` profile
- compare it with the current `1920x1080` default in `src/config.ts`
- make coordinate transforms explicit in traces
- test screenshot labels, clickAt/typeAt, and CUA fallback under both viewports
- promote only if it improves pass rate, latency, or visual reliability

Done when:

- viewport choice is a measured config, not folklore

## Phase 7: Replay And Memory As First-Class Optimization

Goal:

- turn repeated successful work into safe speedups

Work:

- make replay metrics visible in every run summary
- show why a replay candidate matched or was rejected
- capture effect verification quality per replay step
- separate memory used for LLM hints from memory used for deterministic replay
- keep benchmark memory isolated unless memory is the tested intervention

Done when:

- replay can be promoted for repeated workflows without hiding correctness risk

## Phase 8: Failure Taxonomy And Autopsy

Goal:

- every failure should route to the right fix class

Required classes:

- execution bug
- verifier bug
- policy/path inefficiency
- runtime variance
- external blocker
- model output format failure
- observation loss
- action abstraction mismatch
- unsafe completion
- budget exhaustion

Work:

- attach failure class to every failed run
- make `diagnose` consume trace files and produce ranked root causes
- run `autopsy` on every surprising benchmark win or regression
- block promotion when failure mix gets worse, even if headline pass rate improves

Done when:

- the next fix is obvious from the failure report

## Phase 9: Competitive Benchmark Expansion

Goal:

- know where `bad` stands against the field without copying bad benchmark habits

Work:

- add adapters for relevant frameworks only when oracle quality is good enough
- add Online-Mind2Web, BU Bench V1, and Odysseys runners only behind clear caveats
- keep model parity and same-day baseline rules
- report impossible tasks separately
- always separate harness comparison from model comparison

Done when:

- we can reproduce or refute external claims with our own artifacts

## Phase 10: Product-Grade Operator Experience

Goal:

- make traces and optimization visible to humans

Work:

- upgrade run viewer to show phase flame chart, token chart, cost chart, action timeline, model calls, tool calls, screenshots, and failure class
- add per-turn diff view: what the model saw, what it did, what changed
- add "why this was expensive" report
- add "why this failed" report
- add "what to optimize next" report

Done when:

- a user can inspect a run and understand it in under five minutes

## Quality Bar

| Dimension | Target |
|---|---|
| Simplicity | Fewer concepts, clearer boundaries, smaller prompts |
| Reliability | Tier 1 100%, Tier 2 trending to 100%, Tier 3 tracked honestly |
| Observability | Every sub-step has a span with cost, latency, tokens, action, result, and error fields |
| Cost | Cost per successful task trends down without pass-rate regression |
| Latency | Wall time trends down by reducing LLM calls and dead waits |
| Safety | Secrets, credentials, and authenticated actions remain bounded and auditable |
| Generality | No benchmark-only hacks in the default path |
| Taste | Code reads like a small control system, not a pile of special cases |

## Non-Negotiable Gates

- `pnpm lint`
- `pnpm check:boundaries`
- `pnpm test`
- `pnpm telemetry:rollup --fail-on-agent-integrity` for any captured agent telemetry used in promotion
- Tier 1 deterministic gate
- relevant Tier 2 authenticated repeat gate when credentials are available
- `pnpm ab:experiment` for promoted runtime changes
- `pnpm bench:compete` for external comparison claims
- `critical-audit` before merging broad architecture changes
- `harden` before calling a new execution mode production-ready

## Anti-Goals

- Do not make the prompt longer to hide architecture weakness.
- Do not add an action type when a clearer primitive or compound action already exists.
- Do not optimize one public benchmark by weakening real-world behavior.
- Do not claim a result without repeated validation.
- Do not make observability optional for serious runs.
- Do not let the JS actor bypass domain, secret, auth, or artifact policy.

## The First Three Moves

1. Build the span-based trace layer.
   - This unlocks honest optimization.
   - It should be behavior-neutral.

2. Run a prompt-minimality A/B.
   - This tests the simplicity thesis directly.
   - It should use existing eval rigor.

3. Prototype the code-native actor as a challenger.
   - This tests the largest architectural bet.
   - It must be sandboxed, traced, and easy to reject.

## Success Criteria For The Moonshot

The project reaches the target state when:

- any run can be replayed mentally from trace artifacts
- every model call has exact token and cost accounting
- every tool call has bounded args and result telemetry
- every failure has a useful class
- prompt size is intentionally small and justified by measured outcomes
- the code-native actor has either won honestly or been rejected honestly
- Tier 1 remains 100%
- Tier 2 is reliable on repeated authenticated workflows
- Tier 3 and competitive benchmarks are reported with caveats and artifacts
- docs, code, traces, and benchmark reports all tell the same truth

## Final Standard

World class means the harness is not only capable. It is legible.

Unbeatable means competitors can copy a feature, but they cannot copy the compounding loop: simple abstractions, exhaustive traces, rigorous experiments, fast diagnosis, and disciplined promotion.
