# CLAUDE.md

Agent Browser Driver product operating guidance (greenfield, high-ROI, no overengineering).

## Mission

This project is a general-purpose agentic browser automation tool.

Primary objective:
- reliable and performant completion of real user outcomes
- for both persona-driven workflows and direct task-driven inputs

Non-goals:
- over-specializing for a single app
- adding features that increase complexity without measurable completion gains

## Product Defaults (Ship)

1. Reliability over novelty:
- Default model: `gpt-5.2`.
- Default execution remains single-model unless explicitly opted into adaptive routing.

2. Wallet behavior:
- Wallet mode is an extension feature.
- Wallet mode activates only when `wallet.enabled=true` or extension paths are provided.
- `wallet.userDataDir` alone does not activate wallet mode.

3. Evidence quality:
- Every real run should produce report + manifest + recording artifact.
- `fast-explore` for day-to-day speed, `full-evidence` for release signoff.

4. General-purpose first:
- Tangle-specific personas/hints remain optional, never required for core success.

## Experimental Features (Flagged Only)

1. Adaptive model routing:
- Keep behind `--model-adaptive`.
- Do not make default until pass-rate is non-regressive against control.

2. Trajectory memory/scoring:
- Keep behind `--memory` and `--trace-scoring`.
- Always isolate memory directories for clean benchmark arms.

## Benchmark Policy

1. Required matrix:
- A: control (single model)
- B: adaptive
- C: adaptive + memory

2. Must track:
- pass rate
- median duration
- token usage
- artifact completeness

3. Promotion rule:
- No pass-rate regression vs control, plus meaningful latency/token improvement.

## Rollback Plan

1. Immediate runtime rollback (no code revert):
- Disable adaptive routing.
- Disable memory/scoring.
- Continue with control defaults.

2. Targeted wallet rollback:
- If existing workflows depended on legacy `userDataDir` behavior, restore legacy activation in `src/browser-launch.ts`.

3. Full rollback:
- Revert the feature commit on `main`.

## Skills Distribution Policy

1. Canonical skills live in-repo under `skills/`.
2. Install via `npm run skills:install`.
3. Avoid per-app copy/paste drift; consume the shared pack.
