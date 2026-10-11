# Wave-5 hillclimb delta: snapshot budget, corroboration coverage, replay productization — bad driver vs its #159 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash · **Corpus:** 5 tasks × 3 reps main + **reps=5 variance arm** (dashboard-extract, hn) + isolation reruns · **Oracle:** external · **Headless throughout** · **Spend:** $0.94 Gemini across wave-5 benches (56 runs); OpenAI untouched.

**Baseline:** PR #159 / wave-4 (`agent-results/competitive-gemini-wave4-20261011`): bad 15/15, $0.0221 mean/run, 17.7s wall, cached-input 28%.

**Wave-5 main corpus** (`agent-results/competitive-gemini-wave5-20261011`): bad 12/15, $0.0263 mean/run, 26.2s wall, cached 30%; browser-use same-window: 12/15, $0.0140, cached 30%.

## The dashboard-extract 0/3 — weather surrender, proven non-structural

The main corpus's only bad failures: dashboard-extract 0/3 (two turn-1 aborts, one 6-turn struggle). Diagnosis from artifacts: the turn-1 snapshot was byte-identical to wave-4's (4,792 chars, metric headings present) — the model **confabulated a "previous failed run" and aborted** ("The previous run on this exact goal explicitly stated that extraction of these values failed"), a premature-surrender pattern in a provider-weather window. Proof it wasn't a wave-5 change:

- **Isolation rerun** (identical code, ~10 min later): **3/3 pass** ($0.0182 mean).
- **reps=5 variance arm** (identical code): **5/5 pass** ($0.0173 mean, 13.5s).
- Combined day evidence for the cell: 8/11 across three corpora — variance cell confirmed, now with n≥5 stats behind it. No change dropped (the regression rule's isolation showed no change caused it).

## Variance arm (reps=5, the stats firm-up)

| framework | task | pass | input tok/run | $/run | wall s |
|---|---|---|---|---|---|
| bad | dashboard-extract | **5/5** | 37,255 | 0.0173 | 13.5 |
| bad | hn-top-story-score | **5/5** | 27,078 | 0.0169 | 17.3 |
| browser-use | dashboard-extract | 3/5 | 15,534 | 0.0067 | 14.6 |
| browser-use | hn-top-story-score | 5/5 | 33,014 | 0.0154 | 18.9 |

bad's two historically flaky cells went 10/10 at n=5 — and **bad beat browser-use on dashboard-extract 5/5 vs 3/5** in the same window.

## Main-corpus delta (bad, #159 baseline → wave 5)

| task | pass | input tok/run | $/run | wall s |
|---|---|---|---|---|
| form-fill-multi-step | 3/3 → 3/3 | 67,259 → 70,425 | 0.0267 → 0.0285 | 20.5 → 22.9 |
| dashboard-extract | 3/3 → 0/3 ⚠ (weather, see above) | 29,298 → 31,006 | 0.0140 → 0.0176 | 11.5 → 19.4 |
| dashboard-edit-export | 3/3 → 3/3 | 57,412 → 57,080 | 0.0226 → 0.0233 | 16.6 → 18.5 |
| wikipedia-fact-lookup | 3/3 → 3/3 | 64,811 → **42,230 (−35%)** | 0.0247 → **0.0174 (−30%)** | 13.5 → 12.2 |
| hn-top-story-score | 3/3 → 3/3 | 28,875 → 54,908 (one 7-turn rep at 271k... no, at 124k) | 0.0225 → 0.0447 | 26.5 → 57.8 |
| **mean** | **15/15 → 12/15** | 49,531 → 51,130 | **0.0221 → 0.0263** | 17.7 → 26.2 |

The mean is dragged by the weather window's struggle reps (hn rep3: 7 turns / 124.6k tokens / $0.087). Clean-cell costs held or improved (wikipedia −30%, var5 cells at $0.017).

## What moved what

1. **New-page snapshot budget 24k→12k** (`e86f996`) — wikipedia −35% input, −30% cost (the extraction-moat cell *improved*); form cells flat (their snapshots were already <12k). The windowing header fires only above the budget and points at extractWithIndex. Verified it did NOT cause the dashboard-extract weather cell (snapshot 4,792 chars — budget never engaged).
2. **Goal-literal corroboration** (`e0b6417`, `3648977`, `ff16ba4`) — wave-4 had 8/15 completions on the full `llm` verifier path; wave-5 main: **6 llm of 12 completions**, 2 corroborated zero-LLM accepts, 3 llm-slim, 1 fast-path. Two artifact-driven fixes followed: contraction artifacts in literal extraction (a possessive swallowed the real literal's opening quote — debugged against forms-arm artifacts), and form-consume haystack extension (field literals vanish from the success page but live in prior observations). **Verified live post-fix: edit-export 3/3 with verifier paths `{corroborated: 3}` — zero LLM verification calls, $0.017/run vs $0.022 pre-fix.** Remaining uncovered: multi-literal form-echo goals (e.g. form-fill's select values like 'other' don't echo as page text) still take the llm/fast path by design.
3. **Replay productization** (`ad7dd58`) — route-normalized `:id` keys (recorded `startPath`, gated in `findReplayCandidate`, legacy trajectories stay eligible), `BAD_MEMORY_DIR` CI convention (flag wins over env), and `AgentResult.replay` staleness metrics in report.json. **Demo re-proven**: run 2 events = `run-started → run-completed`, zero decide calls, metrics `{attempted:true, outcome:'completed', 3/3 steps, llmCallsUsed:1}`, pass in 8s (live: 5 turns/$0.014).
4. **Extraction-stall escalation** (`00fede3`) — the wave-4 15-turn loop's mechanism named from artifacts: strategy oscillation (script-error ↔ extract-empty) resets the error-based abort ladder on every switch. New cross-strategy miss counter with hard-stop feedback at 4. **Fired zero times** in wave-5 corpora (no loops to stop).

## Remaining failure taxonomy

- **Pass failures: weather surrender (dashboard-extract 0/3 window, proven non-structural at n=11).**
1. **Premature-surrender aborts** — the model confabulates constraints ("previous run failed") and aborts at turn 1 with the data visible. A "never abort on turn 1 without attempting extraction" guard is the wave-6 candidate.
2. **Cost gap persists at ~1.9×** this window ($0.0263 vs BU $0.0140) — honest read on parity below.
3. **Long-tail variance persists at low frequency** (one 7-turn/124k hn rep in the main corpus; none in the n=5 arm).

## Is cost parity with browser-use (~$0.013/run) reachable?

Honest read: **not full parity in this architecture — a ~1.3–1.6× asymptote is realistic, 1.0× is not.** browser-use's per-turn context is ~15–17k tokens by construction (their DOM serializer sends only interactive elements plus a compact state); bad's floor is a system prompt (~3.5k, cached) + a 12k-char windowed snapshot (~3.5k tokens) + a 20k-char history tail (~5k tokens) + goal/turn chrome per decide — call it ~13–16k per decide plus thinking-token output (~1–2k). The remaining 1.5× is mostly (a) bad's multi-turn counts on extraction tasks (2–7 turns vs browser-use's 2), and (b) thinking-token billing. Both are shrinkable but not to zero: turn counts track the model's strategy choices, and thinking is what keeps pass rate at 15/15 (wave-1/4 experiments that cut it cost pass rate). The credible path to ~1.3×: corroboration coverage for the remaining llm-path completions, turn-1 surrender guards, and replay eating CI-rerun cost entirely. Chasing 1.0× would mean compromising the two things that are actually better here — extraction accuracy (5/5 vs 3/5 on dashboard-extract at n=5) and the verified-replay moat.

## Honest caveats

- The main corpus ran under a provider-weather window that also hit browser-use (12/15); the isolation + var5 evidence is the antidote narrative, and all three corpora are cited.
- The corroboration refinement (prior observations in the haystack) landed after the main bench; its verifier-path numbers will show in wave-6's corpus. The wave-5 main paths (6 llm / 2 corroborated) are pre-refinement.
- reps=5 halves but doesn't kill Wilson CI width; treat the 5/5 cells as "no evidence of flakiness" not "proven stable".
- Corpora: `competitive-gemini-wave5-20261011` (main), `competitive-gemini-wave5-var5-20261011` (reps=5 arm), `competitive-gemini-wave5-iso-dx-20261011` (isolation), `competitive-gemini-wave5-forms{,2,3}-20261011` (corroboration fix verification — forms3 is the post-fix proof). Baseline: `competitive-gemini-wave4-20261011`.
