# Master Roadmap — All Generations Audited
## Updated 2026-04-11 after Gen 27 + stealth session

**Current**: v0.23.0, Gen 27 shipped. 91.3% WebVoyager (Gen 25 full run). Estimated 93-96% with Gen 27 (full run pending). 44/50 WebbBench held-out. 10/10 competitive.

---

## ✅ SHIPPED (Gen 13-27)

| Gen | What | Status |
|-----|------|--------|
| 13 | Vision-first (screenshot primary) | ✅ |
| 14 | History screenshot stripping, cost cap | ✅ |
| 15 | Unified vision+DOM prompt | ✅ |
| 16 | DOM planner, snapshot compression, self-verification | ✅ |
| 17 | 2× timeout, 200k cap, date picker bypass prompt | ✅ |
| 18 | Diff-focused observation, multi-action turns | ✅ |
| 19 | Progressive strategy-shift on rejection | ✅ |
| 20 | Vision-aware planner (screenshot in plan calls) | ✅ |
| 22 | Model cascade (gpt-4.1-mini for DOM turns) | ✅ Partial — vision cascade also shipped in Gen 27 |
| 23 | Set-of-Marks (SoM) visual grounding | ✅ |
| 24 | URL-first navigation | ✅ (renamed from "Action Replay") |
| 25 | Streaming evidence extraction | ✅ |
| 26 | 10min timeout, 30 turns, URL fallback discipline | ✅ |
| 27 | Search fallback, form reset detection, CAPTCHA, stealth, card dedup, mouse humanization, system Chrome | ✅ |

---

## 🔨 NEXT UP

### Gen 21: Parallel Tab Exploration + Evidence Accumulation
**Impact: +2-5pp on compound goals. The only remaining CAPABILITY gap.**

Multi-tab execution for goals like "compare flights on Google Flights vs Kayak" or "find 5 restaurants with rating > 4.5." Currently the agent does these sequentially, burning turns navigating between sites.

Changes:
1. Goal decomposer — 1 cheap LLM call decides if goal splits into sub-goals
2. Parallel browser tabs — independent sub-goals run simultaneously
3. Evidence accumulator — structured JSON tracks partial results across tabs
4. Smart trigger — only fires when goal has comparison/multi-item signals

**Effort**: Medium-heavy (2-3 sessions). Tab lifecycle management, sub-agent coordination, evidence merging.

### Gen 28: Multi-Model Orchestrator
**Impact: Better cost/quality tradeoff. Config change, not architecture.**

Already have separate planner, executor, verifier, supervisor. Just need:
- `plannerModel/Provider` config
- `executorModel/Provider` config  
- `verifierModel/Provider` config
- `supervisorModel/Provider` config
- Each brain method reads its own config, defaults to main model

**Effort**: Half a day. Mostly config plumbing through DriverConfig → Brain constructor.

### Gen 29-30: Production API Audit
**Impact: Product readiness. Drew thinks mostly done — needs audit.**

Check what exists in bad-app:
- CLI programmatic interface (library usage)
- Steel driver integration
- Session API
- Live viewer (SSE streaming)
- Multi-tenant isolation
- Rate limiting, billing hooks

**Effort**: Audit = 1 hour. Gap fill = depends on findings.

---

## 📋 NOT YET BUILT (from roadmaps)

### Gen 24b: Trajectory Replay / Checkpoint Recovery
**Original**: When an action fails, navigate back to last known-good URL and retry from checkpoint.
**Status**: Not built. The idea is sound but the form stall → DDG fallback partially addresses recovery.
**Remaining value**: Could help with wrong-answer failures where the agent went down a wrong path.
**Effort**: Medium. Need checkpoint save/restore in runner + retry logic.

### Gen 26b: Site Pattern Learning (Runtime Memory)
**Original**: Save per-domain patterns (cookie banner, search form, date picker bypass) to JSON. Inject on revisit.
**Status**: We have project-level memory (knowledge store) but NOT per-domain pattern extraction.
**Remaining value**: High for repeat visits — skip 2-3 turns of cookie/modal dismissal. Less useful for benchmarks (first visit only).
**Effort**: Medium. Pattern extraction after successful runs + inject as extraContext.

### Gen 22b: Open Model Distillation
**Original**: Fine-tune Qwen2.5-VL-7B on successful trajectories. Own the weights.
**Status**: Not built. Trajectory collection not started.
**Remaining value**: 4-7× cost reduction. Strategic independence from OpenAI.
**Effort**: Heavy (data pipeline + fine-tuning + eval loop). Multi-session.

---

## 💡 IDEAS NOT IN ANY ROADMAP

### DataDome Bypass
**Problem**: 2 WebbBench sites (alltrails.com, nj.com) use DataDome ML behavioral detection that resists all our stealth measures.
**Ideas**:
- Longer idle periods before first interaction (DataDome watches time-to-first-action)
- Mouse micro-movements during "thinking" pauses
- Realistic scroll-before-click patterns
- Page warm-up: load page, wait 5-10s, scroll, THEN interact
**Effort**: Medium. Behavioral timing changes in the runner.

### Browser Extension Mode
**Problem**: Headless browser is always detectable to some degree. 
**Idea**: Run bad as a Chrome extension in the user's real browser. Zero fingerprint issues — it IS a real browser. User's existing cookies, login sessions, everything.
**Effort**: Heavy. Different architecture (extension API vs Playwright).

### Persistent Browser Profile
**Problem**: Fresh profile every run = suspicious. Real users have history, cookies, bookmarks.
**Idea**: Maintain a long-lived browser profile with accumulated state. Warm it up with casual browsing before benchmark runs.
**Effort**: Low. Already have `--profile-dir`. Just need to not wipe it between runs.

### Smart Retry with Different Strategy
**Problem**: When a task fails, we don't retry with a different approach.
**Idea**: On failure, analyze the trace → pick an alternative strategy → retry once. "Date picker failed → try URL. URL failed → try DDG. DDG failed → try keyboard-only."
**Status**: Partially exists (form stall → DDG fallback). But not as a general retry-with-strategy mechanism.
**Effort**: Medium.

### Context Window Optimization
**Problem**: Conversation history grows linearly. At 30 turns, history is 30-60k tokens.
**Idea**: Aggressive history compression — keep only last 3 turns + key decision points + evidence. Summarize middle turns to 1-2 sentences each.
**Effort**: Medium. Need smart compression that preserves action-result pairs.

### Speculative Execution
**Problem**: Each turn waits for LLM response before acting. ~2-3s per turn.
**Idea**: While waiting for LLM, speculatively execute the most likely next action (e.g., if on a search results page, pre-load the first result). Cancel if LLM chooses differently.
**Effort**: Heavy. Requires prediction + rollback.

### WebArena Support
**Problem**: Only tested on WebVoyager + WebbBench + competitive bench.
**Idea**: Self-hosted WebArena (Reddit, GitLab, CMS clones) for deterministic held-out evaluation. No anti-bot, no site changes.
**Effort**: Medium. Docker setup + task adapter. Infrastructure code exists in `bench/external/webarena/`.

### Adaptive Concurrency
**Problem**: Fixed concurrency 5 for benchmarks. Some sites are slower.
**Idea**: Start at concurrency 1, measure per-site latency, scale up for fast sites, throttle for slow sites.
**Effort**: Low. Just scheduling logic in run-scenario-track.

---

## Priority Stack (my recommendation)

| # | What | Why | Sessions |
|---|------|-----|----------|
| 1 | **Gen 21: Parallel tabs** | Only remaining capability gap | 2-3 |
| 2 | **Full 590 run** | Get the real Gen 27 number | 0.5 |
| 3 | **Gen 29-30 audit** | Know the product gap | 0.5 |
| 4 | **Gen 28: Multi-model** | Cheap win, mostly config | 0.5 |
| 5 | **Persistent browser profile** | Low effort, helps anti-bot | 0.25 |
| 6 | **DataDome bypass** | Unblock last 2 WebbBench sites | 1 |
| 7 | **Site pattern learning** | Speed on repeat visits | 1 |
| 8 | **Context window optimization** | Reduce token waste | 1 |
| 9 | **WebArena support** | Better held-out eval | 1 |
| 10 | **Open model distillation** | Long-term cost moat | 3-5 |
