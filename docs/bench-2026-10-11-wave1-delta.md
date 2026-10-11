# Wave-1 hillclimb delta: bad driver vs its #154 baseline

**Date:** 2026-10-11 · **Model:** gemini-2.5-flash (same model/key/day both harnesses) · **Corpus:** 3 fixture + 2 real-web tasks × 3 reps · **Oracle:** external, per-task · **Browsers:** headless throughout · **Spend:** $2.71 Gemini total across all wave-1 corpora (96 runs); OpenAI untouched.

**Baseline:** PR #154 (`docs/bench-2026-10-11-bad-vs-browser-use.md`): bad 12/15, $0.0503 mean/run, 49.2s mean wall; browser-use 10/15, $0.0120.

**Final wave-1 corpus** (`agent-results/competitive-gemini-wave1-v3-20261011`): **bad 13/15, $0.0591 mean/run, 66.1s mean wall; browser-use 13/15 (unchanged code — provider weather moved it from 10/15).**

## Headline delta (bad, baseline → wave 1)

| task | pass | input tok/run | output tok/run | cached-in/run | $/run | wall s |
|---|---|---|---|---|---|---|
| form-fill-multi-step | 2/3 → 2/3 | 181,920 → 168,116 (−8%) | 6,652 → 7,557 | 19,368 → 15,634 | 0.0712 → 0.0693 | 135.3 → 150.0 |
| dashboard-extract | 3/3 → 2/3 ⚠ | 98,754 → 163,561 (+66%) | 4,524 → 10,020 | 17,329 → 23,132 | 0.0409 → 0.0741 | 29.0 → 55.2 |
| dashboard-edit-export | 3/3 → 3/3 | 74,983 → 104,687 (+40%) | 1,226 → 1,640 | 18,037 → 22,799 | 0.0256 → 0.0355 | 10.0 → 17.7 |
| wikipedia-fact-lookup | 3/3 → 3/3 | 135,352 → 85,911 (−37%) | 2,068 → 1,268 (−39%) | 27,604 → 24,869 | 0.0458 → 0.0289 (−37%) | 20.7 → 16.8 (−19%) |
| hn-top-story-score | 1/3 → 3/3 ✓ | 163,380 → 163,130 | 7,613 → 15,405 | 30,965 → 21,440 | 0.0680 → 0.0875 | 51.0 → 91.0 |
| **mean** | **12/15 → 13/15** | 130,878 → 137,081 (+5%) | 4,417 → 7,178 (+63%) | 21,461 → 19,575 (−9%) | **0.0503 → 0.0591 (+17%)** | **49.2 → 66.1 (+34%)** |

cached-input % of input: 16.4% → 14.3% mean (cache hit share roughly flat; absolute cached input −9%).

## What shipped, what each change moved

Six commits, two bench-reverted sub-changes (bisectable history):

1. **Output truncation fix** (`7e87332`, partially reverted in `517fc56`): Google output cap 600→2000, action-first RESPONSE FORMAT/examples, and — after isolation — thinking budget left at API default. Truncated-JSON retries disappeared from the artifacts, but the projected output-token savings did **not** survive contact: zeroing Gemini thinking cut output tokens 4,417→1,916 and mean cost to $0.0381, yet dropped pass to 11/15 (see reverts). With thinking at default, output billing rose (thinking tokens bill as output) — net +63% output tokens.
2. **type pre-fill click removed** (`6b63b65`): no 30s click-timeout recurred in any wave-1 run (was ~225s of baseline corpus wall). Wikipedia's −19% wall is partly this.
3. **Terminal-action guarantee + done-only final turn** (`80e72af`): the hn flip's backbone. In v3 all three hn reps **completed with correct JSON at turns 5–8** instead of dying at max turns with evidence on the floor; rep 1 shows goal-verification rejecting a premature `comments:0` complete and the agent recovering to the right answer at turn 7.
4. **Feedback/history bounds** (`a916a88`, partially reverted in `67a7dd3`): 1k feedback cap + Zone-1 history 2→1 intact messages kept. Absolute cached-input and input-per-turn fell on clean cells (wikipedia input −37%).
5. **runScript sanitize** (`ced84f7`): zero phantom-`[ref=` scripts in wave-1 artifacts (baseline hn runs had them); bare-return IIFE wrap didn't need to fire — but extractWithIndex recovery (rule 25) is visibly followed in v3 hn artifacts where baseline loops ignored it.
6. **Config defaults** (`9bd64f2`): maxActionsPerTurn 2→4, visionStrategy default always→auto (production-only; the bench's fast-explore runs vision=false so no bench effect).

## Reverts (the regression rule applied)

- **thinkingBudget 0** — wave-1 run with it: 11/15 (dashboard-extract 2/3, hn 0/3). Isolation rerun of those two cells with thinking restored: dashboard-extract **3/3 at 9× fewer tokens** (2-turn wins, 16.9k mean vs 154k), hn 1/3 (= baseline). Zeroing thinking degraded recovery reasoning enough to loop; loops cost more input than the thinking saved. Dropped; `BAD_GOOGLE_THINKING_BUDGET` env remains as A/B hatch.
- **zero-diff "NO CHANGES" snapshot suppression** — form-fill went 0/3 in the final-config validation run: every rep aborted at turn 4 claiming "ELEMENTS list is consistently empty" while page snapshots were a healthy ~1.7kB. Form fills don't alter the a11y tree, so interaction turns show `diffChanges === 0` and the stub replaced the element list. Dropped (feedback cap + Zone-1 kept).

## Remaining failure taxonomy (bad, v3 corpus)

1. **Blind-selector loops** (2 of 3 failures: form-fill rep2 17 turns, dashboard-extract rep3 14 turns): the model guesses CSS selectors it cannot see, ignores rule 25's switch-to-extractWithIndex for many turns, and burns 260-320k tokens in a single run. This is now ~all of the remaining failure mass and the top wave-2 target.
2. **Verifier over-conservatism**: hn rep3 completed with the *correct* JSON at turn 5 and was re-prompted three more times before acceptance (8 turns, $0.087). Pass, but expensive — goal-verification prompt calibration target.
3. **High per-cell variance at n=3**: dashboard-extract measured 3/3, 2/3, 3/3, 2/3, 2/3 across five same-day corpora with Wilson CIs [21%,94%]-vs-[44%,100%] overlap. Treat its 3/3→2/3 line as noise, not a regression signal.

## Honest caveats

- n=3 per cell is the repo minimum; every pass-rate delta here has overlapping Wilson intervals. The hn 1/3→3/3 claim rests on mechanism evidence in artifacts (no max-turns deaths; completes with valid JSON) more than on the count.
- browser-use's 10/15→13/15 with unchanged code quantifies same-day provider weather on this corpus — use it as the error bar for bad's +1.
- Cost/wall increases concentrate in thinking-token output billing (dashboard-extract, hn) and loop runs; clean cells got cheaper and faster (wikipedia −37%/−19%).
- Corpora: `competitive-gemini-wave1-20261011` (all 6 fixes incl. thinking-0), `-final-` (thinking restored, zero-diff still in — caught the form-fill break), `-thinkingon-` (2-cell isolation), `-v3-` (final, cited). Baseline: `competitive-gemini-full-20261011` + `competitive-gemini-fixed-bad-20261011`.
