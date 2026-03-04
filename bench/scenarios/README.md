# Browser Scenario Suite (SWE-bench Style)

Purpose: benchmark agent-browser behavior across realistic task types, while separating deterministic automation from high-risk or policy-sensitive tasks.

## Tracks

1. `local-deterministic`
- Fully controlled fixtures.
- Required in CI.
- Used for regression and speed profiling.

2. `staging-auth`
- Real product flows on owned staging/prod-like apps.
- Requires seeded users or storage state.
- Used for end-to-end quality and blocker recovery.

3. `public-web`
- Stable public pages for research/navigation/scrape-style behavior.
- Non-critical in CI (internet drift risk).

4. `restricted-manual`
- High-friction or policy-sensitive flows (captcha, anti-bot, legal risk, phone verification).
- Human-in-loop only.
- Never run unattended in CI.

## Why this split matters

- Prevents flaky internet tasks from polluting core reliability metrics.
- Preserves generalization by keeping a no-hint baseline.
- Avoids unsafe automation patterns on third-party account systems.

## Recommended categories

- `navigation`: route finding, tab/page traversal.
- `form-completion`: single and multi-step forms.
- `product-usage`: realistic in-app workflow completion.
- `research`: find/extract targeted facts.
- `scraping`: structured extraction with validation.
- `auth`: login/session reuse.
- `blocker-recovery`: quota/modals/gating/permission handling.

## Policy note

Tasks like consumer Gmail signup or third-party API-key provisioning are commonly captcha/phone gated and ToS-sensitive. Treat these as `restricted-manual` unless explicit legal and operational approval exists.
