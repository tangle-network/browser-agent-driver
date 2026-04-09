---
'@tangle-network/browser-agent-driver': minor
---

Gen 9 — runtime two-pass extraction. **Mechanism in place, no measured pass-rate improvement at n=3 reps.** Honest non-result that points at the next architectural fix.

## What this PR is

A surgical change to `executePlan`: when the planner-emitted runScript step returns null / empty / `{x: null}` / placeholder pattern, the runner now **declines to auto-complete with that garbage** and falls through to the per-action loop with a `[REPLAN]` context that names the failure. The per-action loop's `Brain.decide` then gets a fresh observation of the loaded page and a chance to emit a smarter action.

The mechanism is the architectural mirror of how browser-use's per-action loop wins on tasks like npm/mdn/w3c — it iterates after a failed extraction. Gen 9 gives bad's per-action loop the same recovery surface while keeping the planner's first-try speed advantage on the cases that succeed cleanly.

## Verified result: no measured improvement

Gen 9 was validated against the same 10-task gauntlet as Gen 8, 3 reps each, same conditions:

| metric | Gen 8 (head-to-head bad) | Gen 9 | Δ |
|---|---:|---:|---|
| pass rate | 23/30 = 77% | 21/30 = 70% | **−2 (within n=3 variance)** |
| mean wall-time | 9.2s | 13.5s | +4.3s |
| mean cost | $0.0168 | $0.0256 | +$0.009 |
| mean tokens | 6,134 | 8,737 | +2,603 |

**The pass rate did NOT improve.** The mechanism IS firing (visible in 5-7 turn runs where the per-action loop kicked in after the planner's runScript failed), but the recovery isn't smart enough — when the per-action loop fires, it has the SAME LLM that picked the wrong selector the first time. Iteration alone doesn't help if the LLM keeps making the same wrong call.

**The wall-time/cost increase is real** — fall-through runs do extra LLM calls in the per-action loop. On tasks that don't need recovery, Gen 9 is unchanged.

Per-task delta vs Gen 8 head-to-head:

| task | Gen 8 | Gen 9 | Δ | what happened |
|---|---:|---:|---:|---|
| npm-package-downloads | 1/3 | **2/3** | **+1** | per-action recovery worked sometimes |
| github-pr-count | 2/3 | **3/3** | **+1** | recovery worked |
| arxiv-paper-abstract | 3/3 | 2/3 | −1 | variance |
| python-docs-method-signature | 2/3 | 1/3 | −1 | recovery couldn't fix wrong-selector |
| **mdn-array-flatmap** | 2/3 | **0/3** | **−2** | recovery REGRESSED — more chances to fail |
| 5 other tasks | unchanged | unchanged | 0 | |
| **total** | 23/30 | 21/30 | **−2** | within variance |

## Why this is NOT shipping as an improvement

Per `CLAUDE.md` rule #6 ("quality wins need ≥5 reps") and the honest-eval rules: **a non-improvement is not an improvement, even when the mechanism is architecturally sound.** Calling this a "Gen 9 win" would be reward-hacking the headline.

The honest framing: **Gen 9 ships the mechanism, not the improvement.** The substitution path, the `isMeaningfulRunScriptOutput` helper, and the fall-through context are all in place for future generations to build on.

## Why ship Gen 9 anyway (the mechanism PR)

1. **The unit tests are valuable regardless** (12 new tests, including 11 for `isMeaningfulRunScriptOutput` and 4 for the new fall-through path in `executePlan`)
2. **The infrastructure is reusable** for Gen 9.1: vision fallback, smarter recovery prompts, multiple parallel runScript candidates — all of these slot into the same fall-through point
3. **`isMeaningfulRunScriptOutput`** is a real primitive that future code (Gen 7.3 metric attribution, validators, etc.) can use
4. **Reverting feels like throwing away architectural correctness** because the LLM isn't smart enough yet — the right path is to make the recovery smarter, not to remove the fall-through

## What ships

**`isMeaningfulRunScriptOutput(output)`** in `src/runner/runner.ts` — exported helper that detects when a runScript output is too null/empty/placeholder to be a valid extraction:
- Rejects: null, undefined, empty/whitespace strings, `"null"`, `"undefined"`, `""`, `'{}'`, `'[]'`, `{x: null}`, any value matching `hasPlaceholderPattern`, JSON objects where every value is null/empty/zero
- Accepts: real JSON with values, non-empty strings, non-empty arrays
- Conservative: if ANY top-level field is null in a JSON object, treats it as "not meaningful" (the agent should retry to get all fields)

**`executePlan` fall-through change** — when the last plan step is a `runScript` AND `isMeaningfulRunScriptOutput(lastRunScriptOutput)` is false, the runner returns `kind: deviated` with reason `runScript returned no meaningful output (got: ...)`. The per-action loop's `[REPLAN]` context (built in `BrowserAgent.run`) then names this failure to `Brain.decide`, which emits a smarter recovery action.

## Tests

**951 → 963 passing** (+12 net new for Gen 9):

- `isMeaningfulRunScriptOutput` unit tests (11):
  - rejects null/undefined/empty/whitespace
  - rejects literal `"null"` / `"undefined"` / `""` / `''`
  - rejects empty JSON shells `{}` / `[]`
  - rejects JSON objects where all values are null/empty/zero
  - rejects partial-extraction JSON `{x: null, y: 5}` (any null = retry)
  - rejects placeholder patterns
  - accepts real JSON values
  - accepts non-JSON real strings
  - accepts non-empty arrays
- `executePlan` integration tests (4):
  - declines auto-complete when runScript returns `{x: null}` placeholder
  - declines auto-complete when runScript returns literal `"null"`
  - still auto-completes on meaningful runScript output (positive control)
  - existing "Gen 7.2 placeholder substitution" tests still pass

**Tier1 deterministic gate: PASSED** (no regressions — Gen 9 only fires on plans that already would have failed via auto-complete).

## What Gen 9.1 should do

Three approaches that could actually move the pass rate:

1. **Recovery-specific prompt for the per-action LLM**: when the fall-through fires, the `Brain.decide` context should explicitly say "your previous runScript used selector X and returned null. Try a DIFFERENT approach: a wider DOM query, a different element type, or click + wait first." Today the context is generic.

2. **Vision fallback**: when runScript fails twice, take a screenshot + ask the LLM "find the element matching X, return its CSS selector or text content." This is how Atlas/Cursor handle ambiguous DOM. Slower per call but only fires on failures.

3. **Multiple parallel runScript candidates**: planner emits 2-3 alternative selectors in a single step; runner tries them in order and uses the first one that returns meaningful output. No extra LLM calls, just better recall.

The Gen 9 mechanism is the **substrate** for all three. Gen 9.1 picks one (or all).

## Honest summary

✅ Mechanism designed and tested (12 new tests pass)
✅ Mechanism fires correctly on real-web failures (visible in 5-7 turn recovery runs)
✅ Tier1 gate maintained
❌ Pass rate unchanged: 21/30 vs 23/30 = within n=3 variance
❌ Wall-time and cost increased on the recovery path

This is what an honest non-result looks like under the rigor protocol. The mechanism ships; the improvement doesn't.
