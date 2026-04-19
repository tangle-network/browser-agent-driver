# Macro candidates

Drop `*.json` candidate files here. Each file is an agent-proposed macro plus
its eval plan. `pnpm macro:promote --candidate <path>` runs it through the
eval-gated promotion pipeline: baseline (no macro) vs treatment (macro
registered), compared by pass rate / turns / cost / duration across N reps.

Verdicts:

- **promote**: pass rate held AND efficiency win on turns or cost. With
  `--auto-promote` the JSON moves to `skills/macros/<name>.json` and
  `.evolve/experiments.jsonl` gets an entry.
- **reject**: pass rate regressed OR maxTurnsMean criteria violated.
  A `.evolve/candidates/rejected/<name>-<date>.md` capture is written.
- **inconclusive**: neither win nor regression. Stays a candidate.

Schema (example):

```json
{
  "macro": { ...MacroDefinition... },
  "eval": {
    "benchCase": "bench/scenarios/cases/local-cookie-banner.json",
    "config":    "bench/scenarios/configs/planner-on.mjs",
    "modes":     "fast-explore",
    "reps":      3,
    "successCriteria": { "minPassRate": 1.0, "maxTurnsMean": 8 }
  },
  "rationale": "dismissing a cookie banner consistently costs 1-2 turns; a dedicated macro collapses it to one."
}
```
