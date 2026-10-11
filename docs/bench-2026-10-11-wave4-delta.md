# Wave-4 hillclimb delta: extraction token mass + sub-calls + replay — bad driver vs its #158 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 3 fixture + 2 real-web tasks × 3 reps · **Oracle:** external · **Headless throughout** · **Spend:** $1.00 Gemini across wave-4 benches (45 runs incl. A/B arm) + replay spike runs; OpenAI untouched.

**Baseline:** PR #158 / wave-3 (`agent-results/competitive-gemini-wave3-final-20261011`): bad 15/15, $0.0370 mean/run, 21.1s wall, cached-input 18%.

**Wave-4 corpus** (`agent-results/competitive-gemini-wave4-20261011`): **bad 15/15, $0.0221 mean/run (−40%), 17.7s wall (−16%), input −49%, cached-input 28%**; browser-use same-window: 11/15, $0.0150, cached 27%.

Four-wave arc on the identical corpus: pass 13/15 → 15/15 → 15/15 → **15/15** · cost $0.0591 → $0.0470 → $0.0370 → **$0.0221** · wall 66.1s → 51.1s → 21.1s → **17.7s**. bad is now **1.47× browser-use's cost per run** (was 3.8× after wave 2, 2.9× after wave 3) and 15/15 vs its 11/15.

## Headline delta (bad, #158 baseline → wave 4)

| task | pass | input tok/run | output tok/run | cached-in (rate) | $/run | wall s |
|---|---|---|---|---|---|---|
| form-fill-multi-step | 3/3 → 3/3 | 96,363 → **67,259 (−30%)** | 2,321 → 2,600 | 21,452 → 21,963 (22%→**33%**) | 0.0347 → **0.0267 (−23%)** | 20.6 → 20.5 |
| dashboard-extract | 3/3 → 3/3 | 64,636 → **29,298 (−55%)** | 1,601 → 2,067 | 14,737 → 8,616 (23%→29%) | 0.0234 → **0.0140 (−40%)** | 10.7 → 11.5 |
| dashboard-edit-export | 3/3 → 3/3 | 115,136 → **57,412 (−50%)** | 2,237 → 2,134 | 21,053 → 16,155 (18%→28%) | 0.0401 → **0.0226 (−44%)** | 18.4 → 16.6 |
| wikipedia-fact-lookup | 3/3 → 3/3 | 108,301 → **64,811 (−40%)** | 1,864 → 2,097 | 14,964 → 15,256 (14%→24%) | 0.0372 → **0.0247 (−34%)** | 13.3 → 13.5 |
| hn-top-story-score | 3/3 → 3/3 | 104,719 → **28,875 (−72%)** | 7,334 → 5,543 | 17,093 → 7,649 (16%→26%) | 0.0498 → **0.0225 (−55%)** | 42.5 → **26.5 (−38%)** |
| **mean** | **15/15 → 15/15** | 97,831 → **49,531 (−49%)** | 3,071 → 2,888 (−6%) | 17,860 → 13,928 (18%→**28%**) | **0.0370 → 0.0221 (−40%)** | **21.1 → 17.7 (−16%)** |

## What moved what

1. **Token-aware history tail** (`dcbbd76`, item 1) — the wave-3 top cost item, cited artifacts: wave-3 wikipedia turns grew 17k→34k→41k→37k input because the 8-message tail was blind to message size (~30k tokens of re-read history per call). The tail now materializes on a 20k-char budget as well as the message cap: fat extraction histories compact to ~2 pairs + summary; lean interaction runs are unchanged. **Mean input −49%; extraction moat held — dashboard-extract and wikipedia stayed 3/3.** Cached-input *rate* rose to 28% (smaller tail ⇒ the cached system prefix is a bigger share).
2. **hn variance stabilized** (`dcbbd76`, item 4) — mechanism named from wave-3 rep2 artifacts: NOT a strategy fork; three malformed-JSON turns at out=3992 (Gemini thinking counts against maxOutputTokens and starved the visible JSON mid-script at the 2000 cap). Fixes: google decide cap 2000→4096 + rule 27 (short single-purpose runScript payloads). hn went from a 19k–271k spread (one malformed-JSON loop rep) to **26–49k, 3/3, mean −72% input, −55% cost**.
3. **Verified-step replay spike** (`ecd9045` + `0c1770e`, item 3) — the persistence seam already existed (TrajectoryStore + `findReplayCandidate` + `--replay` + self-healing controller); the spike proved it end-to-end and fixed three real breaks: read-only steps in recorded trajectories healed every replay (excluded at save); no settle before final verification (async UI at replay speed); and — the big one — **the verifier's own output cap truncated its verdict JSON** (thinking counts against maxOutputTokens; cap now 4096 for google), a bug that was silently reprompting live runs too. **Proof** (artifact `/tmp/bad-replay-run5`): live run 5 turns / $0.015 → replay run events are `run-started → run-completed` with **zero decide calls**, one goal-verification call, pass in 8s. Cache key design (as shipped): goal Jaccard ≥ threshold + origin match + TTL; fail-closed via guard + effect verification + self-heal to the live agent.
4. **Sub-call routing A/B** (`4b732ca`, item 2) — `BAD_SUBCALL_MODEL=gemini-2.5-flash-lite` routes verifier calls to the lite model (decide never sub-routed; LiteLLM pricing covers flash-lite). Arm result: **14/15, $0.0295** — dominated by the primary-model default on both axes (15/15, $0.0221). Verifier tokens are a small share of run cost, and the arm's dashboard-extract rep looped 15 turns. **Not adopted**; the env knob stays for future arms.

## Remaining failure taxonomy

- **Pass failures: none (15/15, third consecutive corpus).** Cost/token mass:
1. **browser-use is still 1.5× cheaper** ($0.0150 vs $0.0221): its per-turn context is ~17k vs our ~24k. Next lever: shrink the per-turn user message (snapshot budget 24k→? for new pages, tighter goal echo), not the history.
2. **Verifier still fires on 8/15 completions as full `llm` calls** (fast-explore form tasks without script evidence need page-state judgment). Corroboration coverage could extend to text-in-snapshot oracles.
3. **Occasional long-tail loops remain possible** (subcall arm's 15-turn dashboard-extract rep): the blind-selector class is guarded, but strategy loops on extraction strategy choice survive at low frequency.
4. **Replay is a spike, not a product**: keying is goal-similarity + origin (no route-normalized path component yet), no cache-dir convention for CI, no staleness metrics. The PR body carries the design notes.

## Honest caveats

- n=3 per cell; Wilson CIs overlap. Mechanism evidence (turn-level artifacts per fix) is stronger than the counts.
- Subcall-arm cost is computed at the run model's rates for all tokens (verifier tokens included since wave 2); lite-verified runs would be very slightly cheaper than reported. The arm lost on pass rate anyway — no adoption case.
- Replay spike runs used the fixture server on 127.0.0.1:8123 and /tmp sinks; their artifacts are outside agent-results (spike, not bench).
- Host load during wave-4 benches was moderate; browser-use ran in the same window.
- Corpora: `competitive-gemini-wave4-20261011` (cited), `competitive-gemini-wave4-subcall-20261011` (A/B arm). Baseline: `competitive-gemini-wave3-final-20261011`.
