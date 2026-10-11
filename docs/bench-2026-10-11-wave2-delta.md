# Wave-2 hillclimb delta: cost/efficiency — bad driver vs its #156 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 3 fixture + 2 real-web tasks × 3 reps · **Oracle:** external · **Headless throughout** · **Spend:** $1.77 Gemini across wave-2 corpora (48 runs incl. A/B arm + smoke); OpenAI untouched.

**Baseline:** PR #156 / wave-1 final (`agent-results/competitive-gemini-wave1-v3-20261011`): bad 13/15, $0.0591 mean/run, 66.1s wall, cached-input 21.6k/run (16%).

**Wave-2 corpus** (`agent-results/competitive-gemini-wave2-20261011`): **bad 15/15 (clean sweep), $0.0470 mean/run, 51.1s wall, cached-input 26.5k/run (23%)**; browser-use 13/15, $0.0125, cached 35% (unchanged code).

## Headline delta (bad, #156 baseline → wave 2)

| task | pass | input tok/run | output tok/run | cached-in (rate) | $/run | wall s |
|---|---|---|---|---|---|---|
| form-fill-multi-step | 2/3 → **3/3** | 168,116 → 180,080 | 7,557 → 8,332 | 15,634 → 20,745 (9%→12%) | 0.0693 → 0.0749 | 150.0 → 164.4 |
| dashboard-extract | 2/3 → **3/3** | 163,561 → **19,882 (−88%)** | 10,020 → 1,005 | 23,132 → 6,466 (14%→33%) | 0.0741 → **0.0085 (−89%)** | 55.2 → **6.2** |
| dashboard-edit-export | 3/3 → 3/3 | 104,687 → 117,935 | 1,640 → 2,137 | 22,799 → 43,576 (22%→**37%**) | 0.0355 → 0.0407 | 17.7 → 16.2 |
| wikipedia-fact-lookup | 3/3 → 3/3 | 85,911 → 129,364 | 1,268 → 2,280 | 24,869 → 31,364 (29%→24%) | 0.0289 → 0.0445 | 16.8 → 18.0 |
| hn-top-story-score | 3/3 → 3/3 | 163,130 → 138,350 | 15,405 → 9,905 | 21,440 → 30,313 (13%→22%) | 0.0875 → **0.0663 (−24%)** | 91.0 → **50.8 (−44%)** |
| **mean** | **13/15 → 15/15** | 137,081 → **117,122 (−15%)** | 7,178 → **4,732 (−34%)** | 21,575 → **26,493 (+23%; 16%→23%)** | **0.0591 → 0.0470 (−20%)** | **66.1 → 51.1 (−23%)** |

browser-use same-day (unchanged): 13/15, in 30.8k, cached 35%, $0.0125 — bad remains ~3.8× its cost per run; cache-rate gap narrowed (16%→23% vs its 35%).

## What moved what

1. **Prefix-stable history** (`00a73b0`, option (b): append-only summary + untouched 4-turn tail; system prompt byte-stable, heavy-page rules moved to the tail user message). Cache rate 16%→23% mean, edit-export cell to 37% (browser-use parity on that cell). **Did not reach the ≥36% target** — an offline repro (`/tmp/cache-repro.mjs` pattern) proves requests are now strictly byte-stable/appended, so the residual gap is Gemini implicit-cache opacity (variable hit behavior per shape/size), not our message churn. The explicit `cachedContent` API is the real lever and is out of scope for this wave.
2. **Verifier instrumentation + slimming + corroborated accept** (`147dc5d`): verifier paths in the wave-2 corpus — **5 corroborated (zero LLM call), 3 fast-path, 2 llm-slim (evidence-only prompt), 9 llm (full)**; verifier tokens are now inside run metrics (68.4k total across 15 runs, previously invisible). hn mean cost fell 24% — the wave-1 rep3 pattern (correct JSON re-prompted 3×) now resolves deterministically.
3. **Blind-selector guard** (`f0c01e6`): **fired zero times** — and the failure class it targets produced zero max-turn loop-deaths this corpus (form-fill rep2's 18 turns were date-field struggle, not selector hallucination). It remains a fail-closed net; the guard's documented-fallback match needs one tightening (see taxonomy).
4. **A/B thinkingBudget=512** (env hatch, default untouched): **12/15, $0.0504, 75.1s** — dominated by the API default on both axes (default: 15/15, $0.0470, 51.1s; thinking-0 from wave 1: 11/15, $0.0381, 29.1s). Dynamic default thinking wins; no middle value worth adopting. @ai-sdk/google 3.0.34 accepts arbitrary integer budgets, so the arm was runnable as specified.

## Remaining failure taxonomy (bad, wave-2 corpus)

- **Pass failures: none (15/15).** Cost/wall mass concentrates in:
1. **Date-field/form-widget struggle loops** (form-fill reps 2–3: 12–18 turns, 200–303k tokens). The model re-fills stable fields turn after turn; not selector hallucination — widget-level confusion. Now the top cost item.
2. **Wikipedia input growth** (86k→129k): reps 2–3 took 5 turns where wave 1 took 2 — extraction-strategy variance, passes but expensive.
3. **Guard gap**: `[data-testid="dob"] input` (a combinator rule 15 explicitly bans) passed the guard's prefix match — tighten the documented-fallback check to exact-form only in wave 3.
4. **Cache rate still 23% vs browser-use 35%** despite provably byte-stable prefixes — needs the explicit `cachedContent` path, not more prompt hygiene.

## Honest caveats

- n=3 per cell; Wilson CIs overlap. The 15/15 is one corpus on one day — the two flipped cells (form-fill, dashboard-extract) were the corpus's known variance cells, and their wave-2 wins come with mechanism evidence (dashboard-extract: three straight 2-turn passes at ~20k tokens vs 14-turn loops; form-fill: no aborts).
- Verifier path counts above are from `goal-verification-completed` events — a new event type this wave; earlier corpora can't be re-analyzed retroactively.
- A/B arm and main bench ran back-to-back same day; provider weather between arms is possible but both directions are reported.
- Corpora: `competitive-gemini-wave2-20261011` (cited), `-think512-` (A/B arm), `-smoke-` (2-task integration check). Baseline: `competitive-gemini-wave1-v3-20261011`.
