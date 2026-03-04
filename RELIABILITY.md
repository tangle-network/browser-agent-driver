# Reliability Runbook

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

## Experiment Rules

- Adaptive routing and memory are flag-only.
- Compare A/B/C on identical scenarios and environment:
1. A = control
2. B = adaptive
3. C = adaptive + memory
- If pass rate drops, do not promote.

## Non-Negotiables

- No merge that reduces Tier 1 pass rate.
- No merge that reduces Tier 2 pass rate without explicit rollback plan.
- Every run must emit manifest + report + recording artifact.

## Rollback

1. Runtime rollback:
- disable adaptive routing
- disable memory/scoring

2. Code rollback:
- revert latest merged change-set if reliability regresses on Tier 1/2.
