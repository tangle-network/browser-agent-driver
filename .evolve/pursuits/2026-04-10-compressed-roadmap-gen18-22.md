# Compressed Roadmap: Gen 18-22
## 30 generations of insight in 5 shipments

Baseline: Gen 17 = 78.8% projected on full WebVoyager (590 tasks), $0.25/task

---

## Gen 18: Adaptive Observation + Parallel Actions
**Ships: Gen 20-25 + Gen 31-35 ideas compressed**

The agent currently uses ONE observation mode for the entire run. But different moments need different tools:
- Landing on a new page → vision (see the layout)
- Filling a form → DOM refs (precise, fast)
- Reading a data table → runScript (structured extraction)
- Navigating a map → vision coordinates (canvas/WebGL)

### Changes
1. **Auto-observation selection per turn** — Brain.decide checks the page context and picks the right mode. No config flag needed. Rules:
   - First turn on new URL: always vision (screenshot + compact DOM)
   - Same-page form interaction: DOM-only (no screenshot, saves ~8k tokens)
   - Stall/error recovery: escalate to vision
   - extractWithIndex/runScript result available: DOM-only to process it
   
2. **Multi-action output** — The model already has `nextActions` in the response format but it's rarely used. Make it the default: emit 2-3 actions per turn when they're sequential and obvious. Cuts total turns 30-40%.

3. **Planner screenshots** — Give the planner ONE screenshot alongside the DOM snapshot. It can emit better plans when it sees the visual layout. Still DOM-only for execution.

### Expected impact
- Token savings: -40% (skip screenshots on same-page turns)
- Turn reduction: -30% (multi-action batching)
- Better plans: planner sees visual context
- **Projected: 83-85%, $0.12/task**

---

## Gen 19: Site Memory + Self-Correction
**Ships: Gen 26-30 + Gen 36-40 ideas compressed**

### Changes
1. **Site pattern memory** — After completing a task on a site, save learned patterns:
   - Cookie banner location and dismiss strategy
   - Search form location and submission method
   - Date picker bypass URL pattern
   - Common modal/auth wall patterns
   
   On second visit to the same domain, inject these as extraContext. No fine-tuning needed — just prompt context from a per-domain JSON store.

2. **Visual self-verification** — Before emitting "complete", take a fresh screenshot and ask: "Given the GOAL and this screenshot, did I actually succeed?" This is a cheap second LLM call (~2k tokens, text-only with the screenshot) that catches the 21% wrong-answer failures.

3. **Retry with strategy shift** — When a task fails, instead of aborting, try ONE more attempt with a different strategy hint: "Previous attempt failed because [reason]. Try [alternative approach]." Single retry, not a loop.

### Expected impact
- Wrong-answer fixes: converts ~50% of the 33 wrong-answer failures
- Site revisit speed: 2-3× faster on repeat visits
- **Projected: 87-90%, $0.10/task**

---

## Gen 20: Cheap Model Cascade + Vision-Aware Planner
**Ships: Gen 21-25 + the $0.01 path**

### Changes
1. **Model cascade** — Use expensive model (gpt-5.4) for planning and hard decisions, cheap model (gpt-4.1-mini, 9× cheaper) for execution and verification steps. The planner needs reasoning; the executor just follows instructions.

   Split: `plan()` → gpt-5.4, `decide()` DOM-only turns → gpt-4.1-mini, `decideVision()` → gpt-5.4 (needs vision reasoning).

2. **Vision-aware planner** — The planner takes ONE screenshot + DOM and emits plans with BOTH action types:
   ```json
   {"steps": [
     {"action": {"action": "clickAt", "x": 200, "y": 50}, "expectedEffect": "Search box focused"},
     {"action": {"action": "type", "selector": "@search", "text": "flights"}, "expectedEffect": "Query typed"},
     {"action": {"action": "navigate", "url": "..."}, "expectedEffect": "Results page loaded"}
   ]}
   ```
   One LLM call with vision → N deterministic mixed-mode steps. This is the speed breakthrough.

3. **Token budget per phase** — Instead of a flat 200k cap, split the budget: 30k for planning, 100k for execution, 70k for recovery. This prevents the planner from consuming budget the executor needs.

### Expected impact
- Cost: -60% from model cascade
- Speed: -50% from vision-aware planner (fewer per-action vision calls)
- **Projected: 90-92%, $0.04/task**

---

## Gen 21: Parallel Exploration + Compositional Goals
**Ships: Gen 31-35 + Gen 46-50 ideas compressed**

### Changes
1. **Parallel tab exploration** — For search/comparison tasks, open 2-3 tabs in parallel:
   - "Find the cheapest flight" → search Google Flights + Kayak simultaneously
   - "Compare prices" → open both product pages in parallel tabs
   - The driver already supports multi-page (popup adoption). Extend to deliberate parallel exploration.

2. **Goal decomposition** — Complex goals get split into sub-goals automatically:
   - "Plan a trip to Paris under $2000" → [find flights, find hotels, check total]
   - Each sub-goal runs independently, results merged
   - Sub-goals can use different observation modes (flights = vision, hotels = DOM)

3. **Evidence accumulation** — Across turns, the agent builds a structured evidence object:
   ```json
   {"goal": "Find 5 beauty salons with rating > 4.8",
    "evidence": [
      {"name": "Salon A", "rating": 4.9, "source": "Google Maps", "turn": 3},
      {"name": "Salon B", "rating": 4.8, "source": "Google Maps", "turn": 5}
    ],
    "remaining": 3}
   ```
   This prevents the agent from losing track of partial progress on multi-item goals.

### Expected impact
- Multi-item task completion: +15pp on tasks requiring N results
- Speed on comparison tasks: 2× from parallelism
- **Projected: 93-95%, $0.03/task**

---

## Gen 22: Distillation + Production Hardening
**Ships: Gen 41-45 endgame**

### Changes
1. **Trajectory collection** — Every successful run saves a clean trajectory:
   ```json
   {"url": "allrecipes.com", "goal": "...", "turns": [
     {"observation": "DOM snapshot hash + visual description", "action": {...}, "result": "success"}
   ]}
   ```
   Build a corpus of 10k+ successful trajectories across all WebVoyager tasks.

2. **DOM-only distilled model** — Fine-tune gpt-4.1-mini on the trajectory corpus. The model learns:
   - "When ARIA snapshot contains [pattern], the page looks like [description]"
   - "On allrecipes.com, the search box is always the first textbox ref"
   - "Date picker patterns → use URL bypass"
   
   This is the "blind that imagines seeing" — DOM-speed with vision-accuracy.

3. **Fallback chain** — distilled model (fast, $0.01) → gpt-5.4 DOM (medium, $0.05) → gpt-5.4 vision (slow, $0.15). Each level only fires if the previous fails.

4. **Production hardening** — Rate limiting, retry backoff, graceful degradation, cost alerts, run budgets per user.

### Expected impact
- Cost: $0.01/task on known sites, $0.05 on new sites
- Speed: <10s mean on known sites
- **Projected: 95%+, $0.01-0.05/task**

---

## Summary: The Compressed Path

| Gen | Pass rate | Cost | Key unlock | Timeline |
|-----|-----------|------|-----------|----------|
| 17 (now) | ~79% | $0.25 | Planner + vision hybrid | done |
| 18 | ~85% | $0.12 | Adaptive observation + multi-action | next session |
| 19 | ~90% | $0.10 | Site memory + self-verification | session +1 |
| 20 | ~92% | $0.04 | Model cascade + vision planner | session +2 |
| 21 | ~95% | $0.03 | Parallel exploration + goal decomposition | session +3 |
| 22 | ~95% | $0.01 | Distillation + fallback chain | session +4 |

Five sessions to 95% at $0.01/task. Each gen is independently valuable and builds on the previous. No gen requires the next to be useful.
