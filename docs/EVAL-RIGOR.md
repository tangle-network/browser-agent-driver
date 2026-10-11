# Evaluation rigor

Use this protocol for browser quality, speed, turn, token, or cost claims.
Ordinary documentation changes use the relevant repository checks.

## Select the existing runner

| Need | Command | Evidence |
| --- | --- | --- |
| Characterize one configuration | `pnpm bench:validate` | Per-run artifacts and mean/min/max summaries |
| Compare frameworks | `pnpm bench:compete` | Matched tasks, failures, costs, durations, and comparison summaries |

For baseline-vs-candidate comparisons, run `pnpm bench:validate` on both arms
under the same-day, same-machine, same-key control rules in
[docs/bench-2026-10-11-hillclimb-program.md](bench-2026-10-11-hillclimb-program.md).

Read each script's options and the current scenario/configuration files before running it.
The scripts live in `scripts/`; [package.json](../package.json) owns their command mapping.
Quick checks establish execution only and cannot support an improvement claim.

## Design and decision

1. State the user outcome, comparison unit, smallest useful improvement, budget, and stopping rule before collecting evidence.
2. Re-measure the baseline under comparable scenario, model, machine, memory, and execution conditions.
   Record unavoidable differences and do not silently pool them.
3. Isolate the proposed change and retain per-run artifacts, failures, exclusions, and resource use for both sides.
4. Use screening to choose candidates; make the final decision on independent validation data.
5. Report effect direction, sample size, uncertainty, and the decision rule with the result.
   An inconclusive result does not establish equivalence.

Runner defaults and minimum repetition checks are operational starting points, not proofs of statistical power.
Choose enough independent observations to detect the stated improvement.
Repeated runs on one case measure its variability; they do not establish coverage of other tasks.
Binary completion claims need case counts and denominators as well as repetitions.
Cost varies with executed calls, retries, and token use; retain those measurements.

The competitive runner's `spreadVerdict` compares a mean difference with observed ranges.
Treat that field as a descriptive heuristic, not a significance test or evidence of equivalence.
For a promotion claim, inspect the appropriate paired or independent comparison and its uncertainty.
Small samples, dependence between runs, multiple screened candidates, and saturated pass rates can invalidate a confident interpretation.
Bootstrap output alone does not resolve those problems.

Promote only when the stated useful improvement is supported and required completion checks do not regress.
A lucky run or plausible mechanism is not enough.
Investigate surprising results before repeating or publishing them.

## Report

Link complete per-run results and state the tested conditions.
Include baseline and candidate counts, failures, duration, calls, tokens, cost, effect, uncertainty, and exclusions relevant to the claim.
Keep absolute observations separate from comparative claims.
Use the same checked values in the PR, changeset, and research report.
Correct all affected summaries before merge when a result changes.
