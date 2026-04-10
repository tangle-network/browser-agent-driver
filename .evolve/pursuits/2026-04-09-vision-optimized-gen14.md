# Pursuit: Vision-optimized — 95%+ WebVoyager
Generation: 14
Date: 2026-04-09
Status: designing
Branch: main

## Thesis

Gen 13 proved vision-first works (+13pp over DOM-first). The remaining 17% failures are operational: 3 cost-cap hits (barely over 100k tokens), 1 timeout, 1 navigation error. **Gen 14 closes the gap with token-efficient vision history** — strip all screenshots from conversation history, keeping only the current turn. This alone fixes 3/5 failures (83% → 93%). The remaining 2 are Google Maps (canvas-rendered, structurally hard for any agent).

## System Audit

### Current baselines (Gen 13, 1-rep curated-30)
- Vision-first: 25/30 (83%), 41.9s mean wall, $0.162/task
- DOM-first: 21/30 (70%), 50.6s mean wall, $0.107/task

### Failure modes
1. **cost_cap (3 tasks)**: allrecipes-0 (103k), amazon-1 (101k), huggingface-0 (105k). All barely over the 100k cap. Root cause: conversation history accumulates screenshots from past turns. compactHistory() keeps 2 most recent user messages with screenshots. Each screenshot is ~2-4k tokens. Over 8-11 turns, history bloats.
2. **timeout (1 task)**: google-map-0 (120s). Google Maps renders via canvas — screenshots show the map but coordinates don't map to interactive elements. Structurally hard.
3. **navigation error (1 task)**: google-map-1. Agent navigated to wrong location. Not vision-specific — could happen with DOM-first too.

### What exists and works
- Vision-first observation mode (Gen 13): 83% pass rate, faster than DOM on average
- Coordinate-based actions (clickAt, typeAt): working, 1024×768 viewport
- Screenshot persistence for WebVoyager judge: fixed
- compactHistory(): strips ELEMENTS blocks and screenshots from older turns, keeps last 2 intact

### What's tunable without architectural change
- History screenshot retention policy (currently: keep last 2 turns with screenshots)
- Cost cap (currently: 100k tokens, env BAD_TOKEN_BUDGET)
- Timeout (currently: per-case, 120s for WebVoyager)

## Diagnosis

The vision-first observation mode is sound. The failures are token budget management, not accuracy. Each screenshot costs ~2-4k tokens (gpt-5.4 image token pricing: ~1024x768 = 2 tiles at ~340 tokens each ≈ 680 base, but the actual measured cost is higher due to high-detail mode). With 8-11 turns and 2 screenshots in history, the cumulative token count reaches 100k.

The fix is NOT to raise the cap — it's to reduce per-call token cost by stripping screenshots from history. The model doesn't need old screenshots; it can see the current page state in the current screenshot.

## Gen 14 Design

### Thesis
**Strip history screenshots in vision mode to stay under cost cap.** This fixes 3/5 failures with zero accuracy risk — the model has the current screenshot, which is all it needs.

### Changes

#### 1. Vision-mode history compaction (must ship)
In `decideVision()`, strip ALL screenshots from history messages before building the context. Only the current turn's screenshot is included. This reduces per-call image tokens from ~6-12k (3 screenshots) to ~2-4k (1 screenshot).

**Files**: `src/brain/index.ts` (decideVision method, compactHistory call)
**Risk**: low — current screenshot is the primary input; old screenshots are redundant
**Expected impact**: fixes 3 cost-cap failures → 28/30 (93%)

#### 2. Adaptive cost cap for vision mode
Raise the cost cap from 100k to 150k specifically when observationMode is vision/hybrid. Image tokens are information-dense — 100k image-heavy tokens accomplish more than 100k text-heavy tokens.

**Files**: `src/run-state.ts` (cost cap check), `src/runner/runner.ts` (pass observationMode)
**Risk**: low — bounded increase, still prevents runaway
**Expected impact**: safety net for the 3 cost-cap tasks if history stripping isn't enough

#### 3. Vision-first maxTurns boost
WebVoyager curated-30 tasks use maxTurns=15. Vision-first uses fewer tokens per turn (no ARIA snapshot text), so it can afford more turns within the same budget. Raise to 20 for vision mode.

**Files**: `src/runner/runner.ts` or CLI (maxTurns override for vision mode)
**Risk**: low — more turns = more chances to complete, bounded by cost cap
**Expected impact**: helps timeout-adjacent tasks

### Alternatives considered
- **Raise cost cap to 200k globally**: rejected — would also raise cap for DOM-first where 100k is appropriate
- **Add image compression**: rejected — gpt-5.4 image token pricing is tile-based, not byte-based. Compressing doesn't change tile count.
- **Switch to low-detail mode**: rejected — would reduce accuracy on small text/icons

### Success criteria
- WebVoyager curated-30 agent pass rate ≥ 28/30 (93%) on single rep
- No wall-time regression vs Gen 13 (mean ≤ 42s)
- Target: 95%+ on clean 3-rep validation
