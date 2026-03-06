# Reliability Runbook

Canonical strategy, promotion policy, and roadmap live in [docs/roadmap/browser-agent-ops.md](/Users/drew/webb/agent-browser-driver/docs/roadmap/browser-agent-ops.md).
This file is the execution runbook only.

Goal: drive task completion to 100% on scoped benchmark tiers with minimal complexity.

## Scope

- Tier 1: deterministic local fixtures (must stay at 100%).
- Tier 2: authenticated staging core user journeys (target 100%).
- Tier 3: public web variability (observability/learning only).

## Daily Loop

1. Run baseline control (`single-model`) on Tier 1 + Tier 2.
Command:
`npm run reliability:scorecard -- --root ./agent-results --out ./agent-results/reliability-scorecard.json`
2. Aggregate failures by class:
- `max_turns`
- `auth_or_redirect`
- `modal_or_blocker`
- `interaction_or_selector`
- `other`
3. Fix top failure class only.
4. Re-run control baseline.
5. Promote fix only if pass rate is non-regressive and artifacts are complete.

Local presets for faster iteration:
- `npm run bench:local:smoke`
- `npm run bench:local:tier1`
- `npm run bench:local:tier2`
- `npm run bench:local:nightly`

Tier2 local auth loop:
- `pnpm auth:save-state`
- `pnpm auth:check-state ./.auth/ai-tangle-tools.json ai.tangle.tools`
- `pnpm bench:local:tier2`

Local runs append snapshots to `./agent-results/local-history.jsonl` so you can compare current reliability to the previous run without manual diffing.

## Experiment Rules

- Adaptive routing and memory are flag-only.
- For routing/memory studies, compare A/B/C on identical scenarios and environment:
1. A = control
2. B = adaptive
3. C = adaptive + memory
- For other policy work, use baseline + one challenger unless there is a specific reason to add more arms.
- If pass rate drops, do not promote.

## Non-Negotiables

- No merge that reduces Tier 1 pass rate.
- No merge that reduces Tier 2 pass rate without explicit rollback plan.
- Every run must emit manifest + report + recording artifact.
- Tier1 deterministic gate must pass on pull requests before merge.
- Tier1 gate checks artifact completeness (report + manifest + recording), not pass rate alone.
- Tier2 staging gate must pass on pull requests before merge when staging secrets are available.
- Every failed gate run should preserve runtime diagnostics (console, network failures, trace on failure).

## Rollback

1. Runtime rollback:
- disable adaptive routing
- disable memory/scoring

2. Code rollback:
- revert latest merged change-set if reliability regresses on Tier 1/2.
