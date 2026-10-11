# Wave-6 (final) hillclimb delta: surrender guard + form-echo corroboration — bad driver vs its #160 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 5 tasks × 3 reps main + reps=5 variance arm (dashboard-extract, hn) · **Oracle:** external · **Headless throughout** · **Spend:** $0.89 Gemini across wave-6 benches (56 runs incl. forms arms); OpenAI untouched.

**Baseline:** PR #160 / wave-5 (`agent-results/competitive-gemini-wave5-20261011`): bad 12/15 (weather), $0.0263 mean/run, 26.2s wall, cached 30%.

**Wave-6 corpus** (`agent-results/competitive-gemini-wave6-20261011`): **bad 15/15, $0.0223 mean/run, 17.9s wall, cached 30%**; browser-use same-window: 12/15, $0.0126, cached 47%. **Variance arm (`-wave6-var5-`): bad 10/10** (dx 5/5 $0.0241, hn 5/5 $0.0206); browser-use 9/10 (dx 4/5).

## Headline delta (bad, #160 baseline → wave 6)

| task | pass | input tok/run | $/run | wall s |
|---|---|---|---|---|
| form-fill-multi-step | 3/3 → 3/3 | 70,425 → 66,717 | 0.0285 → 0.0265 | 22.9 → 21.6 |
| dashboard-extract | 0/3 (weather) → **3/3** | 31,006 → 60,545 | 0.0176 → 0.0291 | 19.4 → 22.3 |
| dashboard-edit-export | 3/3 → 3/3 | 57,080 → 54,921 | 0.0233 → **0.0201 (−14%)** | 18.5 → **12.0 (−35%)** |
| wikipedia-fact-lookup | 3/3 → 3/3 | 42,230 → **36,374 (−14%)** | 0.0174 → **0.0126 (−28%)** | 12.2 → **5.8 (−52%)** |
| hn-top-story-score | 3/3 → 3/3 | 54,908 → **31,703 (−42%)** | 0.0447 → **0.0232 (−48%)** | 57.8 → **27.5 (−52%)** |
| **mean** | **12/15 → 15/15** | 51,130 → 50,052 | **0.0263 → 0.0223 (−15%)** | **26.2 → 17.9 (−32%)** |

**Verifier paths in wave-6 main: 11 corroborated (zero-LLM), 3 llm, 1 fast-path** — wave-5 was 6 llm / 2 corroborated of 12, wave-4 was 8 llm of 15. The corroboration program now covers ~73% of completions with no model call. **Zero surrender-guard rejections needed** — no surrenders were attempted anywhere in the corpus (the guard is a floor, not a tax).

## What moved what

1. **Premature-surrender guard** (`1572010`) — aborts with <2 executed turns and zero extraction evidence on a reachable page are rejected with a re-prompt naming the element count and extraction actions to try (fail-closed, same site as the selector guard; hard-blocked pages exempt). The wave-5 dx weather scenario is covered by a runner-boundary regression test (real Chromium, stubbed decide: confabulated turn-1 abort → rejected → run completes with visible data), stash-verified to fail without the guard. No live conversions needed — no surrender was attempted in either wave-6 corpus, and the wave-5-style weather window did not recur.
2. **Multi-literal form-echo corroboration** (`05059ec`) — two strict extensions: successful fill/select/type action payloads join the haystack (driver-confirmed values), and literal matching is case-insensitive word-boundaried ('other' matches the page's 'Other' label, not 'bother'). Effect: edit-export −14% cost / −35% wall; the 11/15 corroborated count. **Artifact-driven caveat kept strict by design:** a wave-6 form-fill run that skipped the gender field entirely stayed uncorroborated — skipping a model call on an un-attempted literal would be a false accept, and the llm verifier is the right judge there.
3. **Program wrap-up** — `docs/bench-2026-10-11-hillclimb-program.md`: six-wave arc table, technique→delta attribution, the parity verdict (~1.3–1.6× asymptote; 1.0× is the wrong target because it would compromise extraction accuracy and the replay moat), replay's CI economics, and the standing bench procedure for future engine/model evaluations.

## Remaining taxonomy (program close)

- **Pass failures: none (15/15 + 10/10).**
1. Cost gap to browser-use persists (~1.8× this window, $0.0223 vs $0.0126) — bounded by the accepted verdict; wikipedia is at parity per-run ($0.0126 vs browser-use's overall mean, and browser-use went 0/3 on that cell).
2. The llm-path 3 completions are the honest residue: un-attempted-goal-literal runs and evidence-poor pages where only a model can judge.
3. browser-use's cache rate (47% this window) leads bad's (30%) — the last structural gap, worth one future investigation (their per-step message construction caches history prefixes bad's tail-budget invalidates more often).

## Honest caveats

- The weather cell (dashboard-extract) recovered without the guard firing — wave-5's surrender window simply didn't recur; the guard's value is the regression test, not live evidence.
- reps=5 arm is n=5 per cell — "no evidence of flakiness", not proof of stability.
- Program-total spend figures (~$11) are sums of per-run costUsd estimates at LiteLLM rates, not provider bills.
- Corpora: `competitive-gemini-wave6-20261011` (main, cited), `competitive-gemini-wave6-var5-20261011` (arm), `competitive-gemini-wave6-forms-20261011` (form-echo analysis arm). Baseline: `competitive-gemini-wave5-20261011`.
