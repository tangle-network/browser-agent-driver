# Evolve Progress — Design Audit Closed-Loop System

## Round 1 — 2026-04-04

### Completed
1. Added `vibecoded` audit profile targeting AI-generated/template apps
2. Upgraded audit prompt from ~40 lines to ~120 lines with 8 weighted evaluation areas, pixel-level specificity requirements, CSS fix generation
3. Extended DesignFinding type with `cssSelector` and `cssFix` fields
4. Added `DesignSystemScore` type with 8-dimension breakdown
5. Built `--evolve` flag: closed-loop audit → CSS fix generation → inject → re-audit → compare
6. Built `--reproducibility` flag: runs 3x, reports stddev, pass/fail at ±0.5
7. Created benchmark corpus in `bench/design/corpus.json` with 5 tiers (world-class, good, average, vibecoded, defi)
8. Created benchmark runner `bench/design/run-design-bench.ts` with calibration validation
9. All gates pass: build, boundaries, 635 tests

### Remaining
- Run baseline calibration against corpus to verify scoring ranges
- Test evolve loop end-to-end on a real site
- Tune prompts based on calibration results
- Add more vibecoded test sites once we have real examples

### Architecture
- `src/cli-design-audit.ts` — main CLI handler, profiles, evolve loop, reproducibility
- `src/brain/index.ts:auditDesign()` — LLM evaluation with CSS fix parsing
- `src/types.ts` — DesignFinding, DesignSystemScore, DesignEvolveResult
- `bench/design/corpus.json` — reference sites with expected score ranges
- `bench/design/run-design-bench.ts` — benchmark runner
