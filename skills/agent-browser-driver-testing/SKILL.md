# Agent Browser Driver Testing

Use this skill when you need real, non-mocked browser-agent testing with reproducible artifacts.

## Goals
- Maximize completion reliability first.
- Keep evidence quality high (report + video + screenshots + manifest).
- Make experiments comparable (same cases, same auth state, same env, isolated memory).

## Required Run Discipline
1. Define test cases with explicit user outcomes, not action scripts.
2. Use real environments whenever possible (`staging` or `prod-like`).
3. Capture artifacts in a dedicated output directory per run.
4. Keep one clean control arm before enabling experimental flags.

## Baseline Matrix Pattern
1. Control:
`agent-driver run --cases ... --model gpt-5.2`
2. Adaptive:
`agent-driver run --cases ... --model gpt-5.2 --model-adaptive --nav-model gpt-5-mini`
3. Adaptive + memory:
`agent-driver run --cases ... --model gpt-5.2 --model-adaptive --nav-model gpt-5-mini --memory --trace-scoring`

## Memory Experiment Rules
- Never reuse the same memory directory across control and non-memory arms.
- For clean A/B/C: use `--memory-dir` unique per arm.
- For warm-start tests: intentionally reuse memory directory and label as warm.

## Artifact Checklist
- `report.json`
- `suite/report.md`
- `suite/manifest.json`
- `cli-task/recording.webm` (or converted mp4 path if applicable)
- scenario-level summary (`baseline-summary.json` / `track-summary.json`)

## Failure Triage Order
1. Environment/auth issues (401, expired state, missing API keys).
2. Product blockers (quota modals, permission dialogs, auth walls).
3. Agent policy mistakes (repetition loops, weak completion criteria).
4. Site regressions (DOM/layout changed, route moved, broken controls).

## Pass/Ship Gates
- No pass-rate regression vs control.
- Median duration and token cost materially improved.
- Evidence completeness >= 95% of runs (report + video + manifest).
