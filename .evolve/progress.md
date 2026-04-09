# Evolve Progress

## Generation 9 — CLOSED WITHOUT MERGE — 2026-04-08

**Approach:** runtime two-pass extraction. When planner-emitted runScript returned null/empty, fall through to per-action loop with `[REPLAN]` context.

**Result: NON-IMPROVEMENT WITH COST REGRESSION.**

| metric | Gen 8 (3 reps) | Gen 9 (3 reps) | Gen 9.1 (3 reps) |
|---|---:|---:|---:|
| pass rate | 23/30 = 77% | 21/30 = 70% | 23/30 = 77% |
| mean wall-time | 9.2s | 13.5s | ~13s |
| mean cost | $0.0168 | $0.0256 | ~$0.025 |

**5-rep validation killed mid-flight** after observing reddit-subreddit-titles cost regression: Gen 8 = $0.015/run → Gen 9.1 rep 3 = **$0.25 / 132K tokens**, rep 4 = **$0.32 / 173K tokens** in death-spiral recovery loops. mdn-array-flatmap regressed 2/3 → 0/5.

**Root cause:** iterating with the same LLM that picked the wrong selector produces the same wrong selector. Mechanism without capability change is worthless. Per-action loop also has no token budget cap, so failed recovery burns unbounded cost.

**What we keep:** `isMeaningfulRunScriptOutput()` helper + 12 unit tests (the primitive is still useful for cost gates and validators). PR #59 closed.

**Lesson:** Gen 10 must be a **capability change** (give the LLM new information) not a **mechanism change** (give the LLM more turns).

## Generation 10 — PROPOSED, awaiting decision — 2026-04-08

**Thesis:** Replace placeholder iteration with one architectural change: extract a numbered, text-rich element index from the live DOM and let the LLM reference elements by index instead of by selector. This is the browser-use approach and is the only thing that explains why they win on the 4 tasks where bad loses despite being 7× faster overall.

**Three candidates ranked in `.evolve/pursuits/2026-04-08-gen9-retro-and-gen10-proposal.md`:**
- **A — DOM index extraction** (recommended) — addresses LLM-visibility root cause
- **C — bigger snapshot + text content** — cheap insurance, ~30 LOC
- **B — vision fallback** — Gen 11 material, costs/latency wrong for Gen 10

**Recommended:** A + C as Gen 10. Awaiting user decision before any code changes.

**Hard cost cap** baked into the proposal: any single case > 50K tokens aborts as `cost_cap_exceeded`. This prevents the reddit-style death spirals Gen 9.1 hit.

## Generation 7 — Plan-then-Execute — 2026-04-08

**Thesis:** ONE LLM call per strategy, not per action. The planner makes a single LLM call up front to generate the entire action sequence, the runner executes deterministically without re-entering the LLM until verification fails.

### Verified result (long-form scenario, both modes converged)

| Metric | Gen 5 baseline | Gen 6.1 | **Gen 7** |
|---|---:|---:|---:|
| Turns | 22 | 9 (fast-explore only) | **9 (both modes)** |
| Wall time (fast) | 384s | 53s | **31s** |
| Wall time (full) | 180s | 477s (regression) | **38s** |
| LLM calls | 22 | 9 | **7 (1 plan + 6 decide)** |
| Cost | $0.89 | $0.89 | **$0.22** |

**Total Gen 4 → 7 wall-time speedup: 5.8×.** Cost: 4× reduction vs Gen 6.1.

### Behavior trace

1. **plan-completed**: 3 steps generated in 7.7s (prompt cache hit, 1792/2080 input tokens cached)
2. step 1: `fill (2 targets)` ✓
3. step 2: `click` (Next button) ✓
4. step 3: `click` (radio/Next) ✓
5. **plan-fallback-entered** (3/3 steps done — plan exhausted naturally)
6. 6 more `decide-completed` events from per-action loop (Gen 6.1 batch detector kicks in)
7. Final `complete` action — 9 turns total

### Components shipped (8)

1. `Plan` and `PlanStep` types in `src/types.ts`
2. `plannerEnabled?: boolean` config flag (gated by `BAD_PLANNER=0` env override)
3. 5 new TurnEvent variants (plan-started, plan-completed, plan-step-executed, plan-deviated, plan-fallback-entered)
4. `Brain.plan(goal, state)` — single LLM call generates structured Plan with batch verbs
5. `BrowserAgent.executePlan(...)` — deterministic step executor with verification + fallback signal
6. Planner-first wiring in `BrowserAgent.run` with `[REPLAN]` hint injection on deviation
7. `--planner` CLI flag + `bench/scenarios/configs/planner-on.mjs`
8. Per-step 10s wall-clock cap so single bad steps don't block the run

### Tests
- 881 passing (was 865, **+16 net new**)
- 11 in `tests/brain-plan-parse.test.ts`
- 5 in `tests/runner-execute-plan.test.ts`
- Tier1 deterministic gate: **100% pass rate** ✓

### Three iterations to nail the contract

| Iteration | Failure mode | Fix |
|---|---|---|
| v1 | Planner included date-input spinbutton in batch fill → 5s timeout | Strengthen prompt to OMIT spinbuttons |
| v2 | Planner used single-step `type` on spinbuttons → 30s timeout per step | Add 10s wall-clock cap to plan steps |
| v3-4 | Planner emitted fake `complete` action that hallucinated success | Make `executePlan` return `deviated` on plan exhaustion |
| **v5** | All paths handled correctly | **9 turns / 31s / $0.22 both modes** |

### Verdict
**ADVANCE — the architectural win the entire Gen 4-7 trajectory was building toward.** 5.8× wall-time speedup vs Gen 4 baseline. Both modes converge to identical numbers, eliminating the mode-dependent variance that plagued Gen 6.

---

## Gen 6.1 — Runner-mandatory batch fill — 2026-04-08

**Goal:** Make the Gen 6 batch verbs fire reliably by detecting at runtime when the agent is about to do single-step typing on a multi-field form, and inject a high-priority hint that DEMANDS the next action be a `fill`.

### Verified delta (single A/B run vs Gen 6 baseline)

| Metric | Gen 6 baseline | Gen 6.1 fast-explore | Δ |
|---|---:|---:|---:|
| **Turns** | 22 | **9** | **−59%** |
| **Wall time** | 384s | **53s** | **−86%** (7.2× speedup) |
| **Tokens** | ~360k | 147k | −59% |
| **Cost** | $1.45 | $1.15 | −21% |

The agent's actual behavior on fast-explore (verified from events.jsonl):
- Turn 1: type firstname (single, before detector fires)
- Turn 2: detector fires → fill (4 targets) — fails on date input
- Turn 4: click next
- **Turn 5: fill (6 targets) — SUCCESS**
- Turn 6: click next
- **Turn 7: fill (8 targets) — SUCCESS**
- Turn 8: click submit
- Turn 9: complete

**14 form fields compressed into 2 batch turns** (5 + 7). 9 total turns for a 19-field form.

Full-evidence regressed (17 → 22 turns) — same mode-dependent variance as Gen 6 baseline. The detector fires but the agent's fast-explore vs full-evidence prompt cooking responds differently. Tracked as Gen 6.2.

### Implementation

- New `detectBatchFillOpportunity(turns, state)` function in `src/runner/runner.ts`
- Trigger: last action was `type` on the current URL AND 2+ unused fillable refs are visible in the snapshot
- Tracks usedRefs across the WHOLE run (not just recent N turns) so the detector never asks the agent to re-fill a field
- Also tracks fields filled via batch — `fill` action consumption counts as used
- Emits high-priority (100) ctxBudget entry that lists exact unused @refs from the current snapshot with a worked example
- Gated by `BAD_BATCH_HINT=0` env flag for rollback
- 9 unit tests pin the trigger conditions, edge cases, and the worked-example format

### Tests
- 865 passing (was 856, **+9 net new** for `tests/batch-fill-detection.test.ts`)
- Tier1 deterministic gate: **100% pass** ✓

### Verdict
**KEEP — first end-to-end production speedup that actually moves the needle on the long-form scenario.** 7.2× wall time improvement on fast-explore is the biggest single win in the Gen 4-7 trajectory. Mode-dependent variance on full-evidence is a known follow-up.

### Cumulative Gen 4-6.1 trajectory on the long-form scenario

| Generation | Fast-explore turns | Wall time | Speedup vs Gen 4 baseline |
|---|---:|---:|---:|
| Gen 4 (loop overhead) | ~22 | ~180s | baseline |
| Gen 5 (events.jsonl + lazy) | ~22 | ~180s | none (overhead, not turn count) |
| Gen 6 (batch verbs exist) | 17-22 | varies | mode-dependent, ~10-25% sometimes |
| **Gen 6.1 (mandatory batch)** | **9** | **53s** | **3.4×** |
| Gen 7 (planned) | 4-5 | 15-20s | 12× target |

---

## Gen 5 / Evolve Round 1 — Persist + verify lazy decisions in production — 2026-04-08

**Goal:** Complete the deferred Gen 5 work (events.jsonl persistence, lazy supervisor/override skips) AND verify that the decision cache + deterministic patterns actually fire on real runs.

### Shipped (5 components)

1. **events.jsonl persistence via FilesystemSink**
   - `appendEvent(testId, event)` opens an append-mode WriteStream per testId
   - `closeEventStream(testId)` flushes a single stream; `close()` flushes all
   - TestRunner creates a per-test bus that subscribes the file writer + forwards to the suite-level live bus
   - Verified: 358 events written across 39 turns of long-form on first run; 4 unit tests pass
2. **`bad view` reads events.jsonl for replay**
   - New `findEventLogs(reportRoot)` discovers per-test events.jsonl files alongside report.json, parses each line tolerantly (skips bad lines)
   - Inlined into viewer.html via `window.__bad_eventLogs` so the replay UI can reconstruct the streaming experience post-hoc
   - 5 new unit tests in `tests/cli-view.test.ts` (now 30 total)
3. **Lazy `detectSupervisorSignal`** — only computes when supervisor enabled AND past min-turns gate. Was unconditional every turn.
4. **Lazy override pipeline** — only runs when at least one input that any producer might consume is non-null
5. **Pattern matcher fix for real ARIA snapshot format**
   - Production snapshots use `- button "Accept all" [ref=bfba]` (ref AFTER name, YAML-list indent)
   - Test fixtures used `button [ref=b1] "Accept all"` (ref BEFORE name)
   - Fixed both cookie-banner and modal matchers to extract ref + name independently of position
   - Added regression test pinning the real format

### Bug found + fixed during measurement

**Pattern matcher gate over-restricted.** I had gated `canPatternSkip` on `!finalExtraContext`, which meant the matcher never fired in production because `ctxBudget.add('visible-link', ...)` always populated extraContext on pages with visible links matching the goal (668 bytes on the cookie banner page). Pattern matchers only look at the snapshot text — they don't consume extraContext or vision. Removed the gate from `canPatternSkip` (kept it on `canUseCache` because the cache replays a decision made under specific input conditions).

**Double-counted decide-completed events.** The runner emitted `decide-completed` even when the LLM was skipped via pattern/cache. Fixed: `decide-completed` only fires when the LLM was actually called.

### Verified hit rates

| Scenario | Total decisions | LLM called | Pattern-skipped | Cached | LLM skip rate |
|---|---:|---:|---:|---:|---:|
| local-cookie-banner / full-evidence | 3 | 2 | 1 | 0 | **33.3%** |
| local-cookie-banner / fast-explore | 4 | 3 | 1 | 0 | **25.0%** |
| local-long-form (pre-fix) | 39 | 39 | 0 | 0 | 0% |

The cache hit rate is 0% on every scenario tested — expected for happy-path goal-following runs where each turn has a different snapshot. The cache is for retry/recovery loops; needs a fixture that exercises revisits.

### Tier1 gate
- Pass rate: **100%** ✓
- 840 tests pass (was 830, **+10 net new**)
  - 4 new in `tests/filesystem-sink-events.test.ts`
  - 5 new in `tests/cli-view.test.ts` (findEventLogs)
  - 1 new in `tests/deterministic-patterns.test.ts` (real ARIA format regression guard)

### Honest verdict
**KEEP.** All round 1 deferrals shipped. The pattern matcher's first real-world fire (after the bug fix) is the highest-value moment of this round — it proves the lazy-decisions architecture WORKS in production, not just in unit tests. The 28.6% LLM skip rate on the cookie scenario is the first end-to-end measurement of "lazy LLM calls" actually saving an LLM call.

### What's still pending (Gen 5.2 or Gen 6)
- Inspect mode (viewer-side click handler + /inspect endpoint)
- Shadow streamText for in-flight token display
- Cache hit verification (needs a fixture that exercises state revisits)
- Streaming decode with early action commit (long-deferred Gen 6 candidate)

---

## Generation 5 — Open Loop (events + hooks + lazy decisions) — 2026-04-07

Pursuit: `.evolve/pursuits/2026-04-07-open-loop-gen5.md`
Branch: `gen5-open-loop`

### Shipped (24 components across 3 pillars)

**Pillar A — TurnEventBus + Live Observability**
- `src/runner/events.ts` — typed discriminated-union TurnEvent + bounded-retention bus + DistributiveOmit helper
- `src/runner/runner.ts` — phase emission at every boundary (turn-started, observe-start/end, decide-start/end, decide-skipped-cached, decide-skipped-pattern, execute-start/end, verify-start/end, recovery-fired, override-applied, turn-end, run-end)
- `src/cli-view-live.ts` — SSE `/events` endpoint with replay-on-connect + heartbeat + cancel POST
- `src/cli.ts --live` — opens viewer + streams during run + waits for SIGINT after completion

**Pillar B — Extension API for User Customization**
- `src/extensions/types.ts` — `BadExtension` interface, `resolveExtensions`, `rulesForUrl`, type guards
- `src/extensions/loader.ts` — auto-discovers `bad.config.{ts,mts,mjs,js,cjs}` from cwd + `--extension` CLI flag
- `src/brain/index.ts` — `setExtensionRules`, `composeSystemPromptParts` injects user rules per-section + per-domain after the cached prefix
- `src/runner/runner.ts` — subscribes extensions to the bus, applies `mutateDecision` after the override pipeline
- `src/test-runner.ts` — passes `extensions` + `eventBus` through to every BrowserAgent
- `docs/extensions.md` — full user-facing guide with worked examples

**Pillar C — Lazy Decisions (the user's "lazy load even decisions" question)**
- `src/runner/decision-cache.ts` — bounded LRU + TTL, key = SHA1(snapshot + url + goal + lastEffect + budgetBucket), strips volatile telemetry on cache hit
- `src/runner/deterministic-patterns.ts` — cookie-banner-accept matcher + single-button-modal-close matcher; runs BEFORE the LLM
- `src/runner/runner.ts` — wired both as the first two short-circuits in the decide phase; lazy `analyzeRecovery` only fires when there's an error trail

### Tests
- 830 passing (was 758, **+72 net new**)
- New: `runner-events.test.ts` (15), `decision-cache.test.ts` (15), `deterministic-patterns.test.ts` (11), `extensions.test.ts` (24), `cli-view-live.test.ts` (7)

### Tier1 deterministic gate
- Pass rate: **100%** (4/4 — both modes × both scenarios)
- Total cost: $0.49

### Lazy-loading audit (answering Drew's question)

Already lazy: 11 dynamic imports for provider modules, 13+ for subcommand handlers, patchright-vs-playwright, browser launch, snapshot helpers, CDP session, memory layer, vision capture, cursor overlay. Module loading was NOT the lever.

NOT lazy before Gen 5 (now fixed):
- LLM `decide()` was called every turn unconditionally → now skipped on cache hit and on deterministic pattern match
- `analyzeRecovery` ran every turn → now only fires when there's an error trail
- `detectSupervisorSignal` runs even when supervisor is disabled → deferred to Gen 5.1

### What didn't ship (deferred to Gen 5.1)
- Persisting events to `<run-dir>/events.jsonl` via FilesystemSink subscriber
- Inspect mode (click on screenshot → highlight @ref) — needs viewer-side click handler
- Shadow `streamText` for in-flight token display
- Lazy `detectSupervisorSignal` and lazy override pipeline

### Verdict
**ADVANCE.** Three pillars work as a coherent system: extensions + viewer + decision cache all subscribe to the same TurnEventBus. Pass rate maintained at 100%, no regressions, +72 new tests.

---

## Gen 4 / Evolve Round 1 — Verify infra savings above noise floor — 2026-04-07

**Goal:** Prove or refute Gen 4's per-piece wall-clock wins with statistically significant signal.

**Instrument shift:** Wall-clock tier1 gate (±1556ms pooled stddev) and long-form scenarios (±150s strategic variance) cannot detect 50-300ms infra savings. Pivoted to deterministic micro-bench (`bench/gen4-microbench.ts`) that exercises ONLY the changed code paths against a real Chromium instance.

### Verified deltas (n=20 iterations each, stddev <0.3ms)

| Path | Baseline | Gen 4 | Δ | % |
|------|----------|-------|---|---|
| Cursor overlay click overhead (showCursor=true) | 250.3ms | 8.7ms | **−241.6ms** | **−96.5%** |
| verifyEffect on `click` | 101.1ms | 51.1ms | **−50.0ms** | **−49.5%** |
| verifyEffect on `scroll` | 101.1ms | 0.0ms | **−101.1ms** | **−100%** |
| verifyEffect on `wait` | 101.1ms | 0.0ms | **−101.1ms** | **−100%** |
| verifyEffect on `hover` | 101.1ms | 0.0ms | **−101.1ms** | **−100%** |

**Signal-to-noise ratio:** effect sizes 50-250ms vs measurement stddev 0.3ms = effectively infinite. These are NOT noise — they're deterministic, repeatable, and exactly match the Gen 4 spec.

### Translated to user impact

- **Screen-recording mode (showCursor=true), 50-turn session:** ~12s reclaimed (50 × 240ms cursor overhead removed)
- **Mixed action 20-turn session (~15 verified click/navigate + 5 reads):** ~750ms reclaimed (15 × 50ms + 5 × 100ms = 1250ms total verifyEffect savings)
- **Anthropic provider (untested locally — no key):** 50-150ms TTFT savings per cached turn after turn 1, plus ~$0.0045/turn input cost reduction
- **Cold start (turn 1):** 600-1200ms reclaimed via warmup ping (untested but provider-agnostic)

### Long-form bench scenario

Built `bench/scenarios/cases/local-long-form.json` — a 19-field multi-step form that produces 15-29 turns naturally. **Verdict:** also too noisy for wall-clock comparison (turn count itself varies 15→29 between reps as the agent's strategy changes), but confirmed the new instrumentation hypothesis.

### What worked

- Pivoting from "measure wall clock with LLM in the loop" to "measure changed code paths directly" — produced clean, statistically significant signal in <5 minutes vs 36 minutes of noisy reps.
- bench/gen4-microbench.ts is itself a deliverable — it will catch any future regression of these specific paths deterministically.

### What didn't work

- Long-form scenarios. Made noise WORSE not better. Agent strategic variability (15-29 turns on the same goal) added ±150s on top of LLM call variance.
- Tier1 gate at any rep count for sub-2s infra changes.

### Round 1 verdict

**KEEP** — All 5 measured changes deliver the predicted savings within their target thresholds. Pass rate maintained at 100% on tier1 gate and longform shakeout. Plateau detection: not applicable yet, only round 1.

---

## Generation 4 — Agent Loop Speed — 2026-04-07 (pursue cycle)

Pursuit: `.evolve/pursuits/2026-04-07-agent-loop-speed-gen4.md`
Branch: `main`

### Shipped
1. Drop unconditional 100ms wait in verifyEffect; replace with conditional 50ms (only for click/navigate/press/select)
2. Speculative observe inside verifyEffect — observe runs in parallel with the 50ms settle wait
3. Skip post-action observe entirely on pure wait/scroll actions (cachedPostState short-circuit)
4. Cursor overlay animation overlap — drop 240ms `waitForTimeout` per click; CSS transition runs alongside the action
5. Provider connection pre-warm via `Brain.warmup()` — fired in parallel with first observe; 1-token ping
6. Anthropic prompt caching markers on CORE_RULES via `SystemModelMessage[]` + `cache_control: ephemeral`
7. `cacheReadInputTokens` / `cacheCreationInputTokens` plumbed through Brain → Turn → reports

### Tests
- 758 tests passing (was 748, +10 new)
- New: `tests/brain-system-cache.test.ts` (5 tests) — cache marker construction, byte-stable prefix
- New: `tests/brain-warmup.test.ts` (5 tests) — CLI provider no-ops, env flag, error swallowing
- Updated: `tests/cursor-overlay.test.ts` — drop CURSOR_ANIMATION_MS test

### Tier1 deterministic gate
- Pass rate: 100% (24/24 across 3 reps × 2 modes × 2 scenarios)
- full-evidence: 18,541ms → 17,972ms (−3.1%, ±1,556ms noise — within noise)
- fast-explore:  16,079ms → 16,527ms (+2.8%, ±1,380ms noise — within noise)
- **Verdict:** statistically neutral at this benchmark granularity. Real wins predicted in Anthropic-keyed runs (cache hit) and longer scenarios where 50-300ms savings × N turns add up.

### Architecture additions (Gen 4)
- `Brain.composeSystemPromptParts()` — splits system prompt into stable + dynamic parts
- `Brain.buildSystemForDecide()` — provider-aware: returns `SystemModelMessage[]` for anthropic, `string` otherwise
- `Brain.warmup()` — best-effort connection pre-warm
- `BrainDecision.cacheReadInputTokens` / `cacheCreationInputTokens` — prompt cache observability
- `Turn.cacheReadInputTokens` / `cacheCreationInputTokens` — surface cache stats per turn

### Next generation seeds (Gen 5)
- Streaming decode with early action commit (`streamText` + incremental JSON parse + parallel locator resolution)
- Long-form bench scenario (20+ turns) so infra savings show above LLM noise floor
- Verify Anthropic cache hit rate on a real Anthropic-keyed run (cacheReadInputTokens > 0 from turn 2)
- OpenAI prompt caching audit — automatic detection, but verify it actually fires on our prompts

---

## Generation 3 — Design Audit (archived)

Branch: `design-audit-gen2` (carries both Gen 2 and Gen 3 changes)

## Generation 3 — 2026-04-06

Pursuit: `.evolve/pursuits/2026-04-06-design-audit-gen3.md`

### Shipped
1. ROI scoring on findings — impact, effort, blast, computed roi
2. Cross-page systemic detection — findings on 2+ pages collapse into 1 with blast=system
3. CDP-based axe injection (3-tier fallback for CSP-strict pages)
4. Dynamic per-fragment dimensions — fragments declare custom dimensions, LLM scores them
5. Top Fixes report section — opens every report with ROI-sorted top 5
6. JSON output exposes `topFixes`
7. 28 new unit tests (24 ROI + 4 dimensions)

### Calibration (3 generations)
| Site | Gen 1 | Gen 2 | Gen 3 |
|------|-------|-------|-------|
| Stripe | 9 | 9 | 9 |
| Apple | 9 | 9 | 9 |
| Linear | 9 | 9 | 9 |
| Anthropic | 8 | 8 | 8 |
| Airbnb | 8 | 8 | 8 |

5/5 preserved across all 3 generations. Gen 3 adds top-fixes ROI ranking,
dynamic dimensions (Stripe gets `trust-signals`, Airbnb gets `conversion`),
and live cross-page systemic detection (verified on 3-page Stripe audit).

### Architecture additions (Gen 3)
- `src/design/audit/roi.ts` — pure-function ROI scoring + cross-page detection (167 lines)
- `tests/design-audit-roi.test.ts` — 24 unit tests
- Extended `RubricFragment.dimension`, `ComposedRubric.dimensions`
- Extended `DesignFinding` with impact/effort/blast/roi/pageCount
- Extended `measure/a11y.ts` with CSP-bypass injection ladder

### Next generation seeds (Gen 4)
- 3-turn pipeline (separate ranking call)
- Reference library with embedded fingerprints
- Live evolve loop validation against a real vibecoded app
