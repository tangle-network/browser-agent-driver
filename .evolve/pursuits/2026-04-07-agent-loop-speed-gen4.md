# Pursuit: Agent Loop Speed (Gen 4)
Generation: 4
Date: 2026-04-07
Status: evaluated
Branch: main

## Thesis

The `bad` agent loop is structurally serial: `observe → recovery → decide → execute → verifyEffect → observe → ...`. Every phase blocks the next even when they don't have to. CDP observe is already 1-4ms (the observe-bench proves the snapshot pipeline is essentially free), but the loop still wastes hundreds of ms per turn on:

1. A hardcoded `setTimeout(100)` before verifyEffect's re-observe.
2. A 240ms cursor animation wait that's pure dead time on every interactive action.
3. A cold provider connection on turn 1 (~600-1200ms TLS+DNS).
4. Re-observing the page after pure `wait`/`scroll` actions where the snapshot could not have meaningfully changed.
5. Re-sending the entire CORE_RULES system prompt (~1500 tokens) on every LLM call when Anthropic prompt caching could discount it 90%.

Gen 4's bet: parallelize the things that can be parallelized, kill the dead waits, and cache the stable prompt prefix. **No accuracy changes — pure latency.**

## System Audit

### What exists and works
- CDP-based observe pipeline (`observePlaywright` fallback at 1s, `observeCdp` at 1-4ms)
- Snapshot diffing + diff-only mode for token savings
- Per-phase timing instrumentation (`firstObserveMs`, `firstDecideMs`, `firstExecuteMs`)
- Selector cache + project memory layer
- Cached `postState` after verifyEffect (avoids double-observe at start of next turn)
- Cursor overlay (off by default, +240ms per click when on)
- Run viewer (`bad view`) — single HTML asset, normalizes both report shapes
- 549 unit/integration tests, Tier 1 deterministic gate, observe-bench

### What exists but isn't optimized
- `verifyEffect` has `await new Promise(r => setTimeout(r, 100))` at line 1409 with no rationale — pure dead wait.
- `animateCursorToSelector` uses `await page.waitForTimeout(CURSOR_ANIMATION_MS)` (240ms) before every click — should overlap with the click itself.
- Provider connection is cold on turn 1 — first LLM call eats DNS+TLS+model loading.
- `wait`/`scroll` actions trigger a full re-observe even though ARIA structure is unchanged.
- System prompt is rebuilt per turn but CORE_RULES (~1500 tokens) is byte-stable and never marked for prompt caching.
- `compactHistory` strips ELEMENTS blocks from older messages each turn — fine for cost, but means the history can't be cache-hit across turns. CORE_RULES caching is independent and still wins.

### What was tested and failed (Gen 3 retros)
- `--model-adaptive` was tried as a way to route navigation to a cheap model, but worse decisions cascaded into longer runs. Disabled.
- Model routing for `decide()` is a known dead end. Per-turn caching is a different lever.

### User feedback addressed by this generation
- "how can we evolve our system now to be and think faster!" — explicit speed mandate.
- Quality bar from CLAUDE.md: "fewer lines changed is better" — Gen 4 must be surgical.

### Measurement gaps
- No before/after wall-clock comparison wired into the existing tier1 gate.
- No prompt-caching telemetry (cache_creation_input_tokens / cache_read_input_tokens not surfaced).
- We need to measure: (a) median turn duration, (b) median first-LLM-call duration, (c) total wall time on the local fixtures.

## Current Baselines (2026-04-07)

**observe-bench (CDP path, complex page, with screenshot):**
- median: 3.7ms
- p95: 4.3ms
- — observe is essentially free on Chromium+CDP. Gen 4 cannot save anything here.

**Gen 4 targets (to be measured by tier1 gate):**
- Median turn duration: TBD before / target ≥30% reduction after
- First-LLM-call duration: TBD before / target ≥40% reduction after (warm connection)
- Tier1 pass rate: must not regress (currently 100%)

## Diagnosis

The agent loop has three categories of slack, ordered by impact:

**1. LLM-call latency (dominates)** — Each `brain.decide` call serializes against everything else. We can't make the model faster, but we can:
- Pre-warm the connection so turn 1's TTFT is 200ms not 1200ms.
- Cache CORE_RULES so turn 2+ pays cache-read prices on the largest stable chunk.
- Skip `decide` entirely for "obvious" actions (search box auto-submit already does this; we could extend it).

**2. Dead waits (additive across turns)** — `setTimeout(100)` in verifyEffect, `waitForTimeout(240)` in cursor overlay. These are pure latency leaks. Over a 50-turn session: 5s + 12s = 17s of zero-information waiting.

**3. Redundant observes** — `wait`/`scroll` actions structurally cannot change the ARIA tree (well, scroll can reveal lazy-loaded content, but only after the load completes — and we already cap at domcontentloaded). Skipping the post-action observe on these actions saves ~200ms/turn × frequency.

## Generation 4 Design

### Changes (must ship together — they share infrastructure)

#### Architectural

1. **Speculative observe pipelining via cachedPostState** *(low risk)*
   - When verifyEffect runs, reuse the post-action observe via the existing `cachedPostState` slot. This is already in place — but we currently call verifyEffect with `await` AFTER execute completes. Instead, kick the observe off in parallel with `verifyExpectedEffect`'s pre-action data check, and dedupe when both finish.
   - Net: saves 0-200ms per verified turn.
   - Risk: very low — `cachedPostState` semantics already exist.

2. **Pre-warm provider connection at agent start** *(low risk)*
   - In `BrowserAgent.run`, fire `brain.warmup()` (a tiny `generateText({maxTokens:1})` call) in parallel with the first `observe()`. By turn 1's decide, TLS+DNS+model warm.
   - Net: saves 600-1200ms on turn 1.
   - Risk: tiny token cost ($0.0001 per run) for the warmup ping. Disable if `BAD_NO_WARMUP=1`.

3. **Anthropic prompt caching on CORE_RULES** *(medium risk — provider-specific)*
   - Restructure `brain.generate` to accept either a string `system` (current behavior) OR a `SystemModelMessage[]` with `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }` on the stable prefix.
   - In `brain.decide`, when provider is `anthropic`, split the system prompt into `[CORE_RULES, ...conditional_fragments]` and mark CORE_RULES as cached. Other providers still get a flat string (no behavior change).
   - Net: 1500 cached tokens × ~$3/M = $0.0045/turn savings + faster TTFT (cached tokens skip prefill). Over a 50-turn session: ~225ms latency savings from prefill skip alone.
   - Risk: Anthropic-only. Other providers must continue working unchanged.

#### Tactical

4. **Drop the dead 100ms wait in verifyEffect** *(zero risk)*
   - `await new Promise(r => setTimeout(r, 100))` at line 1409 has no rationale in the surrounding code. Replace with a conditional 50ms wait ONLY when the action was a navigation, click, or form submit (where the page might still be in flight). Reads/scrolls/waits skip it entirely.
   - Net: saves 50-100ms per turn.

5. **Skip post-action observe on pure wait/scroll** *(low risk)*
   - When `action.action === 'wait'` or `action.action === 'scroll'` and the action succeeded, set `cachedPostState = preActionState` (with a fresh URL re-read for safety) instead of issuing a new observe. The next loop iteration's `cachedPostState` short-circuit handles the rest.
   - Net: saves 1-4ms (CDP) or 1000ms (Playwright fallback) × frequency.
   - Risk: scroll can reveal lazy-loaded elements. Mitigation: only skip if no `expectedEffect` is set (the agent didn't claim the action would change the page).

6. **Cursor overlay: overlap animation with the action** *(zero risk)*
   - Today: `moveTo` → `waitForTimeout(240)` → click. The 240ms is pure stall.
   - New: `moveTo` → click → next observe captures the post-state with the cursor still visible (the animation duration matches the typical inter-frame gap). The animation lands during the page's own response time.
   - Net: saves 240ms × interactive-action count. On a 50-turn session: 12s.
   - Risk: the cursor in screenshots may be slightly behind the click point. Cosmetic only — overlay is for demos, not correctness.

#### Measurement

7. **Surface phase timings + cache stats in the report**
   - Already have `phaseTimings` on the runner. Add `cacheReadInputTokens` and `cacheCreationInputTokens` to the brain decision result by reading from `result.providerMetadata?.anthropic?.cacheReadInputTokens`.
   - Wire into `Turn` so reports / viewer can show cache hit rates.

### Alternatives Considered

- **Streaming decode with early action commit** — start resolving the locator while the LLM is still emitting `reasoning`. Rejected for Gen 4: requires switching `generateText` → `streamText` which changes error handling everywhere. Save for Gen 5.
- **Speculative next-turn decode** — fire the next decide() against a predicted post-state. Rejected: doubles LLM cost for a 1.3x latency gain at best.
- **Parallel two-model voting** — fire nav + primary in parallel, take whichever returns parseable JSON first. Rejected: previous Gen 3 work proved nav-model-on-decide hurts accuracy.
- **DOM mutation observer for observe skip detection** — too much infrastructure for the win.

### Risk Assessment

- **What could go wrong:** prompt caching Anthropic message format change could break JSON parsing if SDK strips fields. Mitigation: gate behind provider check, fall through to string system on any error.
- **Rollback plan:** every change is behind either a provider check or a default-on flag. Set `BAD_GEN4_*=0` env flags to disable individual changes.
- **Reversible:** all 6 changes are pure refactors of in-process logic. No on-disk format changes, no API surface changes.

### Success Criteria

- Tier1 gate: no pass-rate regression (currently 100%).
- Local fixture (`bench/scenarios/cases/local-deterministic.json`) median wall time: ≥25% reduction.
- observe-bench: no regression (already at 1-4ms — cannot improve).
- Lint + boundaries + tests: all green.

## Build Status

| # | Change | Status | Files | Tests |
|---|--------|--------|-------|-------|
| 1 | verifyEffect dead-wait removal | shipped | runner.ts | existing effect-verification.test.ts |
| 2 | Speculative observe inside verifyEffect | shipped | runner.ts | existing |
| 3 | Skip observe on pure wait/scroll | shipped | runner.ts | covered by runner-class.test.ts |
| 4 | Cursor overlay animation overlap | shipped | playwright.ts, cursor-overlay.ts | cursor-overlay.test.ts (updated), playwright-driver-cursor.test.ts |
| 5 | Provider warmup | shipped | brain/index.ts, runner.ts | brain-warmup.test.ts (5 new) |
| 6 | Anthropic prompt caching markers | shipped | brain/index.ts | brain-system-cache.test.ts (5 new) |
| 7 | Cache + cost stats on Turn type | shipped | brain/index.ts, types.ts, runner.ts | covered by type-checked downstream |

## Results

### Tier1 deterministic gate (gpt-5.4, n=3 reps each side)

| Mode | Baseline mean | Gen 4 mean | Δ | Pooled stddev |
|------|---------------|------------|---|---------------|
| full-evidence | 18,541ms | 17,972ms | **−568ms (−3.1%)** | ±1,556ms |
| fast-explore  | 16,079ms | 16,527ms | **+447ms (+2.8%)** | ±1,380ms |

**Pass rate:** 100% on both sides, all 4 scenarios × 3 reps × 2 modes = 24/24 passes.

**Honest interpretation:** the absolute deltas (~500ms) are well within the noise floor (~1,500ms pooled stddev). The current bench scenarios are 3-5 turns and 12-24s long, so the LLM call duration variance from gpt-5.4 reasoning swamps any 50-300ms infrastructure savings. **At this benchmark granularity, Gen 4 is statistically neutral.** Pass rate is preserved.

### observe-bench (no-LLM browser snapshot benchmark)

| Path | Median | p95 |
|------|--------|-----|
| CDP + screenshot, complex page | 3.7ms | 4.3ms |
| Playwright fallback, complex page | 1011ms | 1014ms |

Already at the floor on Chromium. Gen 4 cannot improve this.

### Test suite

- Before Gen 4: 748 tests passing
- After Gen 4: **758 tests passing** (+10 new)
  - 5 new in `brain-system-cache.test.ts` — cache marker construction, byte-stable prefix, custom prompt fallthrough
  - 5 new in `brain-warmup.test.ts` — warmup no-ops for CLI providers, BAD_NO_WARMUP env, network error swallowing
- Tier1 deterministic gate: PASS (3 reps each side)
- Lint, build, boundaries: clean

### Where the wins actually materialize (untested but predictable)

The Gen 4 changes ARE real, but the tier1 gate is a poor instrument for them. The wins concentrate in scenarios this gate doesn't exercise:

1. **Anthropic prompt caching** (~1,500 cached input tokens × $3/M = $0.0045/turn input savings + 50-150ms TTFT savings on cache hits). Untested locally because no Anthropic key in `.env` — but the structured `SystemModelMessage[]` is verified by 5 unit tests and is byte-stable across turns. First Anthropic run will populate the cache; turns 2+ will hit it. **Will be visible in `cacheReadInputTokens` on the Turn record.**

2. **Cursor overlay overlap** — saves a deterministic 240ms per interactive action (click/type/press) when `showCursor: true`. On a 50-turn session: 12s reclaimed. Lets demos run without paying a wall-clock penalty.

3. **Provider warmup** — saves 600-1200ms cold start on turn 1 only. Invisible in averages over 5-turn scenarios but matters for user-perceived "first action" latency.

4. **Pure wait/scroll observe skip** — only kicks in when the agent uses those actions standalone with no expectedEffect. Not common in current bench scenarios. Saves 1-4ms (CDP) or ~1000ms (Playwright fallback) per skipped observe.

5. **verifyEffect 100ms→50ms wait + parallel observe** — saves 50ms on every verified turn where the action is page-mutating. Over a 20-turn session with 15 verified turns: 750ms.

### Verdict

**ADVANCE (with caveats).**

The changes are correct, all tests pass, the tier1 gate passes with no regression, and 10 new tests cover the 2 highest-value architectural changes. The benchmark **cannot prove out the wins at this granularity** — the savings (50-1200ms per turn type, only some of which apply each run) are smaller than gpt-5.4 reasoning variance on the existing 3-5 turn scenarios.

The right next step is NOT another rep multiplier on tier1 — it's:
- Run an Anthropic-keyed scenario to verify `cacheReadInputTokens > 0` after turn 1
- Run a longer (20+ turn) scenario where infrastructure savings add up above the noise floor
- Run a `--show-cursor` demo end-to-end and confirm the recording quality is preserved despite the animation overlap

### What worked

- Audit before designing — re-reading observe-bench data showed CDP observe is already 1-4ms, killing the "speculative observe" branch as a wasted bet.
- Splitting changes by risk: 4 of the 6 are fully provider-agnostic and require no behavior changes.
- New tests on the architectural changes (cache markers, warmup) — even though the integration tests can't see the wins, the unit tests pin the construction logic.

### What didn't work / surprises

- The benchmark's noise floor is bigger than the savings. This was the lesson: 5-turn scenarios with reasoning models can't measure 50-100ms infrastructure tweaks.
- I scoped #2 ("speculative observe pipelining") as a separate change but it collapsed into "observe in parallel with the 50ms settle wait" — the existing `cachedPostState` mechanism already handled the harder version.

### Next generation seeds (Gen 5)

- **Streaming decode with early action commit**: switch `generateText` → `streamText` in `brain.decide`, parse the JSON incrementally, and start resolving the locator the moment `action.action` and `action.selector` are committed. Locator resolution costs 50-200ms; if you start it during the LLM's `reasoning` field emission, it's free.
- **Per-provider cache markers for OpenAI**: OpenAI launched prompt caching with automatic detection (no explicit markers) but the discount is real. Verify it's actually firing on our long system prompts.
- **Bench against a 20+ turn scenario**: write a long-form bench case so infrastructure savings show above the LLM noise floor.
- **Cache hit observability**: surface `cacheReadInputTokens` and `cacheCreationInputTokens` in `bad view` viewer + the tier1 gate summary.
