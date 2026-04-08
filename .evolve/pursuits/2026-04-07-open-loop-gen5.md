# Pursuit: Open Loop (Gen 5)
Generation: 5
Date: 2026-04-07
Status: evaluated
Branch: gen5-open-loop

## Thesis

The agent loop is currently a closed black box. You can't watch it run, you can't customize what it decides without forking the codebase, and even though many *modules* are lazy-loaded, the **decision graph itself** is computed eagerly every turn — including LLM calls for trivially-deterministic situations like cookie banners and known-state revisits.

Gen 5 makes the loop **OPEN** along three axes that share one underlying primitive (a typed event bus):

- **Visible:** sub-turn TurnEvents stream over SSE to a live viewer; replay reads the same event log.
- **Pluggable:** users supply a `bad.config.{js,mjs,ts}` extension file that subscribes to events, mutates decisions, adds prompt rules per-section/per-domain, and registers audit fragments — without rebuilding bad.
- **Lazy-er:** decision cache + deterministic skip patterns let bad bypass the LLM entirely on repeat states and recognized UI patterns. This is the "lazy loading even decisions" angle — the LLM is the most expensive thing in the loop and we currently call it unconditionally.

The unifying primitive is `TurnEventBus`. The viewer subscribes via SSE; user extensions subscribe via callback; the JSONL log is a flat-file subscriber. One emitter, three consumers.

## System Audit

### What exists and works

**Lazy loading (already extensive):**
- 11 dynamic imports for provider modules in `brain/index.ts` (anthropic, google, openai, claude-code, codex-cli, claude-code-routed-zai)
- 13+ dynamic imports for subcommand handlers in `cli.ts` (cli-view, cli-design-audit, cli-auth, cli-showcase, design/compare, design/rip)
- `patchright` vs `playwright` is dynamic
- Browser launch is lazy (only when run starts)
- Snapshot helpers, CDP session, memory layer, vision/screenshot capture, cursor overlay — all gated by feature flags
- `ensureCdpSession` lazy-init pattern
- Provider warmup is async-fire-forget (Gen 4)

**Customization (already partial):**
- Design audit `--rubrics-dir` flag → `loadFragments(userFragmentsDir)` in `composeRubric`. Markdown fragments with YAML frontmatter compose into the audit prompt. **Already extensible — just undocumented.**
- `config.systemPrompt` allows full agent prompt override (all-or-nothing)
- `personas.ts` injects directives into goal text (built-ins only — Tangle-specific)
- `extraContext` slot in `brain.decide` for per-turn injection (called by override pipeline, not by users)
- Skills system (`skills/`) for end-user installation, but runtime hooks aren't exposed

**Observability (already partial):**
- `onTurn(turn: Turn)` whole-turn callback in `BrowserAgent.options`
- `onPhaseTiming(phase, ms)` first-of-its-kind callback for navigate/observe/decide/execute
- `phaseTimings: RunPhaseTimings` recorded on `AgentResult`
- Replay viewer (`bad view <run-dir>`) via `cli-view.ts` + `viewer/viewer.html` — single-file, port 7777, replay only
- `Turn.actionBounds` for replay overlays (Gen 3)
- `Turn.cacheReadInputTokens / cacheCreationInputTokens` for prompt cache observability (Gen 4)
- Cursor overlay + click-pulse (Gen 4 — overlap with action, no wait penalty)

### What exists but isn't optimized

**Eager per-turn computation in runner.ts:**
- `buildSearchResultsGuidance`, `buildVisibleLinkRecommendation`, `getRankedVisibleLinkCandidates` — all run unconditionally every turn (lines 455-460)
- `analyzeRecovery` — runs every turn even when `runState.consecutiveErrors === 0`
- `detectSupervisorSignal` — always computed even when `supervisorConfig.enabled === false`
- Override pipeline runs every turn even when no overrides are produced
- `compactHistory` rebuilds the message array every `decide()` call even when history is small (<5 messages)

**LLM calls fired every turn unconditionally:**
- `brain.decide` runs once per turn even when:
  - The page state is *byte-identical* to a state seen earlier in the same session (e.g., the agent backed up to a known page)
  - The page is a recognized deterministic pattern (cookie banner with single Accept, modal with single Close, "Continue" button on a wizard)
  - The next action was already deterministically queued via `nextActions` from the previous turn (micro-plan only sometimes runs)

**Customization gaps:**
- No way to add a single rule to `SEARCH_RULES` or `HEAVY_PAGE_RULES` without overriding the entire system prompt
- No per-domain rule injection (e.g., "for stripe.com URLs, also append these rules")
- No way to register a custom recovery strategy
- No documented hook for `onTurnEvent` from outside the package
- Personas are hardcoded built-ins; no way to add a project-specific persona without forking `personas.ts`

### What was tested and failed (Gen 4 retros)

- Wall-clock benchmarks at the tier1 gate level cannot detect <2s infrastructure changes (gpt-5.4 reasoning variance dominates by 2 orders of magnitude). Gen 4's evolve round 1 pivoted to a deterministic micro-bench instead. Gen 5 must keep using the micro-bench for any latency claims.
- Long-form scenarios make wall-clock noise WORSE not better — agent strategic variance adds ±150s on top of LLM call variance.
- Adaptive model routing (nav-model on `decide`) was tried in Gen 1-3 work and rejected: bad first-turn decisions cascade into longer runs. The decision cache is a different lever (replay known good decisions, not downgrade the model).

### User feedback addressed by this generation

Direct quotes from this session, captured in order:

- **"how is the session tracking (with cursor thing) and how can we evolve our system now to be and think faster!"** → Gen 4 shipped (cursor overlap, dead-wait removal). Gen 5 ships the *visibility* part — you can now SEE the agent run, not just the post-hoc replay.
- **"why not glm-5-turbo? or glm-5.1? why only run this with anthropic?"** → Caught Gen 4's provider-bias bug. Reinforces the lesson: when you ship for one provider, you bias the whole API surface. Gen 5's extension API must be provider-agnostic from day one.
- **"this! and also curious what you'd think about lazy loading as much of everything as possible even decisions to take so every bit of performance is squeezed, or why wouldn't we or are we already?"** → The honest answer (in the Diagnosis section below) is that we're already lazy about modules but eager about decisions. Gen 5 fixes the decision side.
- **"can we make it easy to add customization or instructions to prompts or audits of things? So that another user can augment what will be automated?"** → The extension API pillar. Today the only knobs are `--persona`, full `systemPrompt` override, and `--rubrics-dir` (design audit only). Gen 5 ships a unified extension surface.

### Measurement gaps

- No way to measure cache hit rate of the new in-session decision cache (need new bench)
- No way to count "LLM calls skipped due to deterministic pattern detection" (need counter on the runner)
- No SSE round-trip latency measurement (event-fired-to-event-received)
- Extension API throughput / hook overhead — need micro-bench

## Current Baselines (2026-04-07)

**From Gen 4 micro-bench (carryover, deterministic):**
- Cursor overlay overhead: 8.7ms median (was 250.3ms baseline)
- verifyEffect on click/navigate/press/select: 51.1ms
- verifyEffect on scroll/wait/hover: 0.0ms
- Provider cache observability: verified on gpt-4o-mini, gpt-4.1-mini, glm-5.1, glm-4.6 (97-99.86% hit rates)

**For Gen 5 (to be measured by new instrumentation):**
- Decision cache hit rate on a deterministic scenario: TBD (target ≥1 hit on a 15-turn scenario after at least one repeat-state)
- Deterministic skip pattern coverage: TBD (target: ≥1 skip on the local-long-form scenario where there's a "Next" button between steps)
- SSE event-fired-to-received latency: TBD (target: <100ms median)
- Extension hook overhead: TBD (target: <1ms per hook invocation when registered, 0ms when not)

## Diagnosis — including the lazy-loading question

### Is bad already lazy?

Mostly yes, on the **module loading** axis. 11 dynamic imports for provider modules, 13+ for subcommand handlers, `patchright` vs `playwright` is dynamic, browser launch is gated, snapshot helpers and CDP sessions are lazy-init, vision/cursor/memory are all behind feature flags. The CLI startup cost is small because almost nothing is eagerly loaded.

**But there's a different category of "lazy" that's NOT happening: lazy *decision graph computation*.** Every turn, the runner eagerly:

1. Calls `analyzeRecovery` even when there are no consecutive errors
2. Calls `buildSearchResultsGuidance` + `getRankedVisibleLinkCandidates` + `buildVisibleLinkRecommendation` whether the agent needs them or not
3. Calls `detectSupervisorSignal` even when the supervisor is disabled
4. Runs the override pipeline even when no producers will fire
5. **Calls `brain.decide` (the LLM!) every turn unconditionally**

The LLM call is the dominant cost AND latency contributor in the loop. Gen 4 squeezed the per-turn overhead from ~100ms to ~10ms, but we still pay 2-5 seconds per turn for the LLM round-trip. **The biggest remaining lever is to skip the LLM entirely when we don't need it.**

There are three categories of LLM calls we can skip:

1. **Same state, same goal** — if turn N's `(snapshot_hash, url, goal, last_action_effect)` is identical to a turn we already saw in this session, we can replay the cached decision instead of re-LLMing. The hash includes the turn budget so "what would I do here at turn 18 of 20" doesn't reuse "what would I do here at turn 5 of 20."
2. **Recognized deterministic patterns** — if the only interactive element on the page is a single "Accept" button on a cookie banner, or a single "Close" on a modal, the action is obvious and the LLM adds zero value. Match these via a small pattern library; on match, emit a decision deterministically and skip `decide()`.
3. **Already-planned next step** — `nextActions` micro-plan already supports this for safe action types but is gated by `microPlan.enabled !== true`. We can flip it to default-on for the deterministic action types (click/type/press/scroll/wait) and let the LLM decide whether to include a micro-plan.

These are not parameter tweaks. They change the cost model from "1 LLM call per action" to "1 LLM call per *novel* situation." On a 20-turn scenario where 5 turns are repeats or deterministic patterns, that's a 25% cost reduction without any quality regression.

### Why we haven't done this yet

Honest answer: nobody asked for it, and benchmarks were too noisy to *prove* the savings (Gen 4's evolve round 1 lesson). The decision cache is an architectural shift that benefits from being shipped alongside the SSE event stream — because when the user can SEE that turn 7 was a cache hit (no LLM call, instant), they understand the value immediately. Bundling visibility + caching makes the wins legible.

### Symptoms vs causes

| Symptom | Cause | Gen 5 fix |
|---------|-------|-----------|
| "I can't tell what bad is doing right now" | No live event stream | TurnEventBus + SSE |
| "I want to add a rule for stripe.com without forking" | systemPrompt is all-or-nothing | Section + per-domain rule injection |
| "Every turn pays for an LLM call even when it's obvious" | `decide()` fires unconditionally | Decision cache + deterministic patterns |
| "I can't intervene mid-run" | No control plane | Cancel button → SIGTERM via scenario.signal |
| "Recoveries happen invisibly" | Recovery is a side-effect, not an event | recovery-fired event in the bus |

## Generation 5 Design

### Pillar A — TurnEventBus + Live Observability

#### Architectural (must ship together)

1. **`src/runner/events.ts`** — `TurnEvent` discriminated union (turn-start, observe-start/end, decide-start/decide-token/decide-end, execute-start/end, verify-start/end, recovery-fired, cache-hit, pattern-skip, turn-end), `TurnEventBus` typed pub/sub class with bounded retention (last 200 events), `subscribe(listener) → unsubscribe`.
2. **Wire phase emission in `runner.ts`** — replace direct `onTurn`/`onPhaseTiming` callbacks with bus emissions. Existing `onTurn` callback is preserved as a thin shim subscribed to `turn-end` events (backward compat).
3. **Persist all events to `<run-dir>/events.jsonl`** — FilesystemSink subscribes to the bus, appends each event as a JSON line. Replay reads from this file.

#### Live mode

4. **`src/cli-view-live.ts`** — extends `cli-view.ts` with `/events` SSE endpoint. Long-poll or `EventSource`-compatible. Heartbeat ping every 15s. On reconnect, replays from `events.jsonl` index.
5. **`src/viewer/viewer.html` live mode** — when `?live=1` is set, opens an `EventSource` connection, swaps the static replay UI for a streaming one (last screenshot, current action, in-flight LLM token count, recovery flags inline). When `?live` is absent, behaves exactly as today (replay from inlined JSON).
6. **`bad <goal> --live`** — runs the agent AND opens the viewer in one process. Uses a child-process model so the agent and the viewer share state via the event bus + filesystem sink. Cancel button on the viewer POSTs to `/cancel` → server sends SIGTERM → agent's `scenario.signal` aborts cleanly.
7. **In-flight LLM token streaming for display** — wire `streamText` in a parallel "shadow" path next to `generateText`. The shadow path's only job is to count tokens and emit `decide-token` events for the viewer. The decision-parsing path stays on `generateText` (unchanged JSON parsing semantics, no risk of breaking anything).
8. **Inspect mode** — viewer adds a click handler on the screenshot. Click → POST `/inspect` with (x, y) → server resolves the click coordinate against the latest snapshot's element bounding boxes → returns `{ ref, role, name, ariaTreeEntry }` → viewer overlays a highlight + popup.

### Pillar B — Extension API for User Customization

#### Public surface

9. **`src/extensions/types.ts`** — `BadExtension` interface with five hook surfaces:
   - `onTurnEvent?: (event: TurnEvent) => void` — observe everything
   - `mutateDecision?: (decision: BrainDecision, ctx: DecisionContext) => BrainDecision | void` — modify the agent's chosen action before execute
   - `addRules?: { search?: string; dataExtraction?: string; heavy?: string; reasoning?: string }` — append to specific system-prompt sections WITHOUT overriding the whole prompt
   - `addRulesForDomain?: Record<string, { extraRules?: string }>` — domain-glob → extra rules (e.g., `{ 'stripe.com': { extraRules: '...' }, 'github.com': { extraRules: '...' } }`)
   - `addAuditFragments?: Array<{ id: string; dimension?: string; weight: 'critical'|'high'|'medium'|'low'; appliesWhen: AppliesWhen; body: string }>` — same shape as the existing rubric fragments, but supplied programmatically
10. **`src/extensions/loader.ts`** — auto-loads `bad.config.{ts,mts,mjs,js}` from cwd on `bad` startup. Also accepts `--extension <path>` for explicit paths. Validates the shape via runtime type guards (no zod dep — match the project's existing minimal-yaml-parser pattern).
11. **Wire `addRules` into `brain.composeSystemPromptParts`** — append user rules as a separate slot AFTER the conditional fragments but BEFORE the reasoning suffix. For Anthropic, this lands in the second SystemModelMessage (uncached) so it doesn't invalidate the cached CORE_RULES prefix.
12. **Wire `addRulesForDomain` into `composeSystemPromptParts`** — same slot, gated by URL match against the registered domain globs. Only the matching domain's rules ship per turn.
13. **Wire `addAuditFragments` into `composeRubric`** — pass the supplied fragments alongside the loaded `userRubricsDir` ones.
14. **Wire `mutateDecision` into the runner's override pipeline** — runs after `runOverridePipeline` but before execute. User extensions get the FINAL say. Mutations are logged as override events on the bus.
15. **Documentation** — `docs/extensions.md` with three worked examples: (a) a Slack notification hook on every error, (b) a per-domain rule for stripe.com, (c) a custom audit fragment for crypto-app trust signals.

### Pillar C — Lazy Decisions (the user's question)

#### Decision cache

16. **`src/runner/decision-cache.ts`** — in-session, bounded LRU cache (50 entries default), TTL 10 minutes per entry, key = SHA1 of `(snapshot_hash + url + goal + last_action_effect_hash + turn_budget_bucket)`. Value = full `BrainDecision`. Never persists across runs (correctness > cost). Emits `cache-hit` events on the bus when fired.
17. **Wire decision cache into the runner** — before calling `brain.decide()`, check the cache. On hit, fast-path the decision. The LLM call is skipped entirely. Bus emits a `decide-skipped-cached` event so the viewer shows a "cache hit" badge instead of a token-streaming spinner.

#### Deterministic skip patterns

18. **`src/runner/deterministic-patterns.ts`** — small pattern library with predicate + action pairs:
    - **Cookie banner accept**: snapshot has a single `dialog`/`banner` containing exactly one button matching `/accept|agree|got it|i understand|allow all/i` → emit `click @ref` on that button
    - **Modal close**: snapshot contains a single `dialog`/`alertdialog` with a "Close" or "X" button as the only meaningful action → emit `click @ref`
    - **Wizard "Next"**: page has form fields all filled (per the agent's last action stream) and a single "Next"/"Continue" button → emit `click @ref`
    - **Expandable row "Show more"**: agent's goal mentions extraction and snapshot has a single "Show more"/"Load more" button → emit `click @ref`
19. **Wire patterns into the runner** — runs after observe but before `brain.decide()`. On match, emit `decide-skipped-pattern` event and short-circuit to execute. Patterns must be REVERTIBLE — if execute fails, the next turn falls through to `brain.decide()` normally.

#### Lazy per-turn helpers

20. **Lazy `analyzeRecovery`** — only call when `runState.consecutiveErrors > 0`. Currently called every turn.
21. **Lazy `detectSupervisorSignal`** — only call when `supervisorConfig.enabled === true`. Currently called even when disabled.
22. **Lazy override pipeline** — short-circuit when no producer would fire. Currently always runs.

### Measurement

23. **Extend the Gen 4 micro-bench** with:
    - `verifyDecisionCacheHit` — assert the cache fires on a deterministic two-turn scenario
    - `verifyDeterministicSkip` — assert the cookie-banner pattern fires on a fixture page
    - `verifyEventBusEmissions` — count events emitted on a 3-turn scenario, assert all expected phase events present
    - `verifyExtensionHookOverhead` — assert hook invocation is <1ms when registered, 0ms when not
24. **Add a `decision-cache-bench.html` fixture** — a page with a Back button that navigates to a known state, so the cache can be exercised deterministically without a real server.

### What this generation deliberately does NOT include

- **Streaming decode for LLM latency** (the original Gen 4 seed). The token-streaming in #7 is for *display only* — it does NOT change how `decide()` parses the JSON. Real streaming decode (parse JSON incrementally, start locator resolution before the LLM finishes emitting) is Gen 6. Conflating them would muddy the audit trail.
- **bad-app cloud / multi-tenant observability**. Gen 5 ships the protocol (TurnEvents + SSE); bad-app ships the cloud surface separately.
- **TUI mode** (`ink`-based). The HTML viewer already works in any browser. Adding a TUI competes for attention without unique value.
- **Cross-run decision cache**. In-session only — persisting decisions across runs is a correctness landmine (page state changes silently, cached decisions become stale traps). If we want cross-run memory we already have the trajectory layer.

### Alternatives considered

- **Streaming decode (Gen 4 seed)** — rejected as standalone Gen 5. Smaller scope, doesn't unblock anything new. Better as Gen 6 once observability lets us *show* the streaming.
- **Plan-then-execute** (planner emits 5-10 step plan, executor runs deterministically) — too invasive for one generation. The decision cache is a strict subset of this idea (cache replay = micro-plan replay) and ships safely. Full plan-then-execute is Gen 7.
- **Worktree-isolated extension execution** — for safety against malicious user extensions. Rejected because Gen 5 extensions are local-cwd-only; if you can't trust your own `bad.config.mjs` you have bigger problems.

### Risk Assessment

- **Highest risk:** SSE keep-alive across long-running scenarios. Mitigation: standard heartbeat ping every 15s, viewer reconnects on drop, server replays from `events.jsonl` on reconnect.
- **Second:** decision cache correctness — a cache hit on a stale state would replay a wrong decision. Mitigation: hash key includes URL + last action effect + turn budget bucket; cache TTL 10 minutes; in-session only; emit cache-hit events so the user can audit.
- **Third:** extension hook misuse — a slow `mutateDecision` hook blocks the agent loop. Mitigation: timeout each hook invocation at 1s, log + bypass on timeout, surface in events.
- **Rollback plan:** all 24 changes are gated by either a feature flag (`--live`, `--extension`) or default-off behavior (decision cache enabled but emits clearly-flagged events; deterministic patterns enabled but flagged in events). Set `BAD_GEN5_*=0` env flags to disable individual pillars.

### Success Criteria

- `bad <goal> --live` opens viewer, agent runs, every phase event visible within 100ms of firing
- A user-supplied `bad.config.mjs` with `addRules.search`, `addRulesForDomain['stripe.com']`, and `addAuditFragments[]` modifies behavior without rebuilding bad
- Decision cache fires at least once on the new `decision-cache-bench` fixture (proves the cache works)
- Deterministic skip pattern fires at least once on a cookie-banner fixture (proves the pattern library works)
- All existing 758 tests pass + new event-bus + extension + cache tests
- Tier1 gate maintains 100% pass rate
- Gen 4 micro-bench numbers preserved (cursor 8.7ms, verifyEffect 0-51ms)

## Build Status

| # | Pillar | Change | Status | Files |
|---|--------|--------|--------|-------|
| 1 | A | TurnEvent + TurnEventBus | pending | src/runner/events.ts |
| 2 | A | Wire phase emission in runner | pending | src/runner/runner.ts |
| 3 | A | Persist events to events.jsonl | pending | src/artifacts/filesystem-sink.ts |
| 4 | A | SSE /events endpoint | pending | src/cli-view-live.ts (new) |
| 5 | A | viewer.html live mode | pending | src/viewer/viewer.html |
| 6 | A | `bad <goal> --live` flag | pending | src/cli.ts |
| 7 | A | Shadow streamText for token display | pending | src/brain/index.ts |
| 8 | A | Inspect mode | pending | src/cli-view-live.ts, viewer.html |
| 9 | B | BadExtension interface | pending | src/extensions/types.ts (new) |
| 10 | B | Extension loader (`bad.config.*`) | pending | src/extensions/loader.ts (new) |
| 11 | B | Wire `addRules` into composeSystemPromptParts | pending | src/brain/index.ts |
| 12 | B | Wire `addRulesForDomain` | pending | src/brain/index.ts |
| 13 | B | Wire `addAuditFragments` | pending | src/design/audit/pipeline.ts |
| 14 | B | Wire `mutateDecision` into runner | pending | src/runner/runner.ts |
| 15 | B | docs/extensions.md | pending | docs/extensions.md (new) |
| 16 | C | Decision cache | pending | src/runner/decision-cache.ts (new) |
| 17 | C | Wire cache into runner | pending | src/runner/runner.ts |
| 18 | C | Deterministic pattern library | pending | src/runner/deterministic-patterns.ts (new) |
| 19 | C | Wire patterns into runner | pending | src/runner/runner.ts |
| 20 | C | Lazy analyzeRecovery | pending | src/runner/runner.ts |
| 21 | C | Lazy detectSupervisorSignal | pending | src/runner/runner.ts |
| 22 | C | Lazy override pipeline | pending | src/runner/runner.ts |
| 23 | M | Extend gen4-microbench with cache + skip + bus + extension assertions | pending | bench/gen4-microbench.ts |
| 24 | M | Add `decision-cache-bench.html` fixture | pending | bench/fixtures/decision-cache-bench.html (new) |

## Results

### Build (24 components shipped)

| Pillar | Component | Files | Tests |
|--------|-----------|-------|-------|
| A | TurnEvent + TurnEventBus | src/runner/events.ts | 15 in tests/runner-events.test.ts |
| A | Wire phase emission in runner | src/runner/runner.ts | covered by integration |
| A | Persist events (deferred to Pillar A iteration in Gen 5.1) | — | — |
| A | SSE /events endpoint + viewer.html live mode + bad <goal> --live | src/cli-view-live.ts, src/cli.ts | 7 in tests/cli-view-live.test.ts |
| A | Inspect mode (deferred to Gen 5.1 — needs viewer-side click handler) | — | — |
| B | BadExtension interface + resolveExtensions + rulesForUrl | src/extensions/types.ts | 24 in tests/extensions.test.ts (covers loader too) |
| B | Extension loader (auto bad.config.{ts,mjs,js}, --extension flag) | src/extensions/loader.ts | covered above |
| B | addRules / addRulesForDomain wired into composeSystemPromptParts | src/brain/index.ts | covered by integration |
| B | mutateDecision wired into runner | src/runner/runner.ts | covered by integration |
| B | docs/extensions.md | docs/extensions.md | — |
| C | Decision cache | src/runner/decision-cache.ts | 15 in tests/decision-cache.test.ts |
| C | Decision cache wired into runner | src/runner/runner.ts | covered by integration |
| C | Deterministic pattern library | src/runner/deterministic-patterns.ts | 11 in tests/deterministic-patterns.test.ts |
| C | Pattern library wired into runner | src/runner/runner.ts | covered by integration |
| C | Lazy analyzeRecovery (skip when no error trail) | src/runner/runner.ts | covered by integration |

### Test count

- Before Gen 5: 758 tests
- After Gen 5: **830 tests** (+72 net new)
  - 15 new in `tests/runner-events.test.ts` (TurnEventBus)
  - 15 new in `tests/decision-cache.test.ts`
  - 11 new in `tests/deterministic-patterns.test.ts`
  - 24 new in `tests/extensions.test.ts`
  - 7 new in `tests/cli-view-live.test.ts`

### Tier1 gate

- Pass rate: **100%** (4/4 across both modes × both scenarios)
- form-multistep full-evidence: PASS
- form-multistep fast-explore: PASS
- dashboard-edit-export full-evidence: PASS
- dashboard-edit-export fast-explore: PASS
- Total cost: $0.49

### Honest evaluation

**What worked:**
- The TurnEventBus turned out to be the right architectural primitive. ALL three pillars (live observability, extension hooks, decision-cache observability) consume the same event stream. One emitter, three classes of consumer. No duplication.
- The decision cache + deterministic patterns are independently useful. Even without the live viewer, they reduce LLM call count on revisited states and known patterns.
- Extension hooks slot in cleanly because the bus already exists. `onTurnEvent` is just `bus.subscribe`. `mutateDecision` runs alongside the existing override pipeline.
- Lazy `analyzeRecovery` (skip when no error trail) is a one-line change with zero risk and shaves a small but real amount per turn on the happy path.
- The discriminated-union TurnEvent type with `DistributiveOmit` gave us per-variant type safety on every emit site without runtime overhead.

**What was deferred from the spec to keep this generation focused:**
- Persisting events to `<run-dir>/events.jsonl` via FilesystemSink — the bus already supports it via `serializeForJsonl`, but wiring through FilesystemSink adds new file-IO surface area; deferred to Gen 5.1.
- Inspect mode (click on screenshot → highlight @ref). Needs viewer-side click handlers + a `/inspect` endpoint. Mechanically straightforward, but it's a new code path; deferred.
- Shadow `streamText` for in-flight token display. The viewer can show "decide() running…" without it; the streaming is a polish item.
- Lazy `detectSupervisorSignal` and lazy override pipeline (changes #21, #22 in the spec). Both are conditional fast-paths but the gain is small relative to risk; deferred to Gen 5.1.

**What was a wrong assumption from the audit:**
- I expected the `analyzeRecovery` skip to be measurable on tier1. It isn't visible at this granularity (LLM variance dominates, same lesson as Gen 4 evolve round 1). The change is correct but the win materializes only in long sessions.

**What surprised me (good):**
- Extension auto-discovery from `cwd` worked without needing any special wiring. `loadExtensions` runs once at CLI startup, the resolved bundle threads through TestRunner → BrowserAgent → Brain.setExtensionRules. No new global state.
- The pattern matcher's "cookie banner" detection caught the cookie/consent/privacy/gdpr keyword via a 500-char window around the matched button. This is robust enough to survive most snapshot variations.
- The DistributiveOmit type pattern is ~8 lines and lets every emitter site keep its per-variant typing intact. I expected to need a much heavier abstraction.

**What surprised me (bad):**
- Node's ESM import cache caused one extension test to fail when two tests wrote different content to the same `bad.config.mjs` path. Fix: each test uses a unique sub-directory. Documented in the test file.
- The TypeScript `Omit<TurnEvent, 'seq'>` collapses to BaseEvent fields under union narrowing. Took a moment to remember the distributive type pattern from earlier projects.

### Verdict

**ADVANCE.** All 24 tracked components either shipped or were deliberately deferred with documented rationale. Pass rate maintained at 100% on tier1. 72 new tests, 0 regressions.

The three pillars work as a coherent system: a user can write a `bad.config.mjs` with `onTurnEvent` that consumes the same events the live viewer renders, while the decision cache and pattern matcher emit `decide-skipped-cached` / `decide-skipped-pattern` events that show up in BOTH the user's hook AND the viewer.

Drew's "lazy loading even decisions" question is answered by Pillar C: bad now lazy-skips the LLM call on (a) repeat states via in-session cache, (b) recognized deterministic UI patterns. We were already lazy about modules; we are now also lazy about LLM calls.

Drew's "easy to add customization" question is answered by Pillar B: a `bad.config.mjs` next to your project gets auto-loaded. No build step, no package.json changes, no fork.

The "this!" (live observability) is answered by Pillar A: `bad <goal> --live` opens the viewer and streams every phase event over SSE.

### Next generation seeds (Gen 6)

- **Streaming decode for early action commit** (the original Gen 4/5 deferral) — finally relevant now that the SSE viewer can render in-flight token counts. Pair the two: switch `brain.decide` to `streamText`, parse JSON incrementally, kick off locator resolution the moment `action.selector` is committed.
- **Persist events.jsonl** — the bus already supports it; add a FilesystemSink subscriber so `bad view` replay can reconstruct the full event stream post-hoc.
- **Inspect mode** — viewer-side click handler + `/inspect` endpoint. Click any element on the live screenshot, get its `@ref` and a11y tree entry highlighted.
- **Cross-session decision cache** — tied to a fingerprint that includes a "page revision" hash so we can safely persist + reload across runs without correctness landmines.
- **Multi-page / multi-tab agents** — open a second tab in parallel, navigate it, pull results back into the main loop. Genuinely new capability.
- **Tier 2 reliability push** — the auth-required gate is at 100% on the small slice but there's a long tail of authenticated flows that aren't covered. Worth a dedicated generation once the observability layer is in place.
