# Wave-3 hillclimb delta: deep token levers — bad driver vs its #157 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 3 fixture + 2 real-web tasks × 3 reps · **Oracle:** external · **Headless throughout** · **Spend:** $2.05 Gemini across wave-3 corpora (66 runs incl. isolation); OpenAI untouched.

**Baseline:** PR #157 / wave-2 (`agent-results/competitive-gemini-wave2-20261011`): bad 15/15, $0.0470 mean/run, 51.1s wall, cached-input 23%.

**Wave-3 final corpus** (`agent-results/competitive-gemini-wave3-final-20261011`): **bad 15/15, $0.0370 mean/run (−21%), 21.1s wall (−59%), input −16%, output −35%**; browser-use same-window control: 12/15, $0.0128, cached 24%.

Three-wave arc on the identical corpus: pass 13/15 → 15/15 → **15/15** · cost $0.0591 → $0.0470 → **$0.0370** · wall 66.1s → 51.1s → **21.1s**.

## Headline delta (bad, #157 baseline → wave 3 final)

| task | pass | input tok/run | output tok/run | cached-in (rate) | $/run | wall s |
|---|---|---|---|---|---|---|
| form-fill-multi-step | 3/3 → 3/3 | 180,080 → **96,363 (−46%)** | 8,332 → 2,321 | 20,745 → 21,452 (12%→22%) | 0.0749 → **0.0347 (−54%)** | 164.4 → **20.6 (−87%)** |
| dashboard-extract | 3/3 → 3/3 | 19,882 → 64,636 ⚠ | 1,005 → 1,601 | 6,466 → 14,737 (33%→23%) | 0.0085 → 0.0234 ⚠ | 6.2 → 10.7 |
| dashboard-edit-export | 3/3 → 3/3 | 117,935 → 115,136 | 2,137 → 2,237 | 43,576 → 21,053 (37%→18%) | 0.0407 → 0.0401 | 16.2 → 18.4 |
| wikipedia-fact-lookup | 3/3 → 3/3 | 129,364 → **108,301 (−16%)** | 2,280 → 1,864 | 31,364 → 14,964 (24%→14%) | 0.0445 → **0.0372 (−16%)** | 18.0 → **13.3 (−26%)** |
| hn-top-story-score | 3/3 → 3/3 | 138,350 → **104,719 (−24%)** | 9,905 → 7,334 | 30,965 → 17,093 (22%→16%) | 0.0663 → **0.0498 (−25%)** | 50.8 → **42.5 (−16%)** |
| **mean** | **15/15 → 15/15** | 117,122 → **97,831 (−16%)** | 4,732 → **3,071 (−35%)** | 26,493 → 17,860 (23%→18%) | **0.0470 → 0.0370 (−21%)** | **51.1 → 21.1 (−59%)** |

⚠ dashboard-extract: wave-2's three freak 2-turn/20k-token wins didn't repeat (4–6 turns at 54–90k). Regression to the mean, not a change regression — the cell stays 3/3 at $0.023 vs browser-use's $0.007.

## What moved what

1. **Chrome date-control root fix** (`b728470` + `ac76324`) — the wave-2/3 form-fill failure mode (12–21 turn date loops, every spinbutton ref a guaranteed 30s timeout) is **gone**: all 3 final reps pass in 7 turns / ~20s. form-fill cost −54%, wall −87%. Root cause (artifact-cited in commits): Chrome exposes `input[type=date]` as a `Date` group whose shadow spinbuttons carry doubled, unresolvable accessible names ('Month Month'). Both snapshot pipelines (CDP AX tree — the one the bench actually uses, found via isolation artifacts — and the Playwright YAML fallback) now emit a single ref'd `date` line resolved through getByLabel; fill with YYYY-MM-DD works natively.
2. **Explicit Gemini context caching + system-prompt freeze** (`6c0137e`, `5fe9a06`) — cachedContents API with content-hash keys, 10-min TTL, full fallback (live-verified 99% cached-read on repeat identical calls). The freeze killed the mid-run system-prompt flip that split HN's cache entries in two (6410↔3205 alternating reads). Cost effect is inside the −21% mean. Cached-input *rate* reads 18% — the absolute cached tokens cover the system prompt per turn while total input shrank; the rate metric understates the saving.
3. **Serializer port, both pipelines** (`4a48211` + `ac76324`) — nameless structural wrappers (14% of HN bytes in pure nesting) and decorative images dropped, named containers kept (extraction moat guarded by tests — dashboard-extract/wikipedia stayed 3/3), per-node display names capped at 120 chars with full names retained for resolution, added elements marked inline `*new*` instead of the duplicate diff block. Input −16% mean.
4. **Guard tightening** (`bd7d9d4`) — combinator selectors with documented-looking heads now rejected; the guard + wave-2 guard fired **zero times** in the final corpus (their failure classes didn't occur).
5. **Verifier corroboration (wave-2, still paying)** — final-corpus verifier paths: 6 llm, 6 fast-path, 2 corroborated, 3 llm-slim of 17 completions.

## Arc of the wave (three corpora, honest sequence)

- `competitive-gemini-wave3-20261011` (first): 13/15 — form-fill 2/3 (date loop **in the CDP pipeline my first fix didn't cover**) and wikipedia 2/3 (weather; browser-use went 0/3 on it the same hour).
- `competitive-gemini-wave3-iso-20261011` (isolation on regressed cells, per the drop rule): form-fill 3/3 restored but artifacts proved the spinbutton refs survived — that's how the CDP-pipeline gap was found and fixed. Wikipedia 2/3.
- `competitive-gemini-wave3-final-20261011` (all fixes): 15/15 with the numbers above. Nothing needed dropping — no change regressed pass rate after the pipeline port.

## Remaining failure taxonomy

- **Pass failures: none (15/15).** Cost/token mass:
1. **Extraction-turn token mass**: multi-turn extraction runs still burn 50–100k input (vs browser-use's ~17k) — history re-reads + 24k snapshot budget dominate. Next lever: extraction-specific context slimming (smaller same-page budget, tighter compact rules for extraction goals).
2. **hn variance**: rep 2 of the final corpus burned 8 turns / 271k tokens while reps 1/3 took 1–2 turns. Extraction-strategy luck remains the single biggest cost swing.
3. **Cache rate 18–22% vs browser-use 24–35%**: explicit cache covers the system prompt; history-prefix implicit hits remain thin. If worth chasing: cache the system prompt + first user turn jointly, or longer TTLs across reps.

## Honest caveats

- n=3 per cell; Wilson CIs overlap. The form-fill mechanism evidence (zero spinbutton timeouts, 7-turn passes in every rep) is stronger than the count.
- Host conditions degraded mid-day (load average ~242 from unrelated workloads) and recovered (~64) during the final bench; browser-use ran in the same window as the control. Wall times carry a mild load caveat; cost/token metrics are load-insensitive.
- Cache-cost accounting: explicit-cache write+storage (~$0.0016/10-min TTL) is real but below runs.jsonl resolution; the cost math lives in `src/brain/gemini-cache.ts`.
- Corpora: `-wave3-` (first), `-wave3-iso-` (isolation), `-wave3-final-` (cited). Baseline: `competitive-gemini-wave2-20261011`.
