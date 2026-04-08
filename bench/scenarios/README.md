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

4. `webbench`
- External benchmark track derived from Halluminate WebBench tasks.
- Use for cross-agent comparability on realistic web navigation/write tasks.
- Not CI-required (live-internet drift and website policy variance).

5. `restricted-manual`
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

## WebBench Integration

1. Download `webbenchfinal.csv` from WebBench and place it in `bench/webbench/`.
2. Generate sample cases:
`npm run webbench:import -- --csv ./bench/webbench/webbenchfinal.csv --out ./bench/scenarios/cases/webbench-read-sample.json --categories READ --limit 50 --max-per-domain 1`
3. Run sampled WebBench track (cost-aware default):
`node scripts/run-scenario-track.mjs --cases ./bench/scenarios/cases/webbench-read-sample.json --config ./bench/scenarios/configs/supervisor-on.mjs --model gpt-5.2 --benchmark-profile webbench --modes fast-explore`

Benchmark profiles:
- `default`: balanced defaults
- `webbench`: fast, low-noise profile (`--profile benchmark-webbench`)
- `webvoyager`: evidence-rich profile (`--profile benchmark-webvoyager`)

## Larger A/B Experiments (CI + Graph Data)

Run repeated experiments with confidence intervals:
`npm run ab:experiment -- --cases ./bench/scenarios/cases/staging-auth-ai-tangle.json --storage-state ./.auth/ai-tangle-tools.json --repetitions 20 --concurrency 4 --scenario-concurrency 2 --off-config ./bench/scenarios/configs/supervisor-off.mjs --on-config ./bench/scenarios/configs/supervisor-on.mjs --out ./agent-results/ab-exp-staging`

Canonical spec-driven execution (recommended):
`npm run ab:experiment -- --spec ./bench/scenarios/specs/supervisor-ab-webbench.json --out ./agent-results/ab-exp-webbench`

Supervisor vision challenger:
`npm run ab:experiment -- --spec ./bench/scenarios/specs/cycle-webbench-reach4-supervisor-vision.json --out ./agent-results/ab-exp-supervisor-vision`

Notes:
- `ab:experiment` defaults to `--modes fast-explore` when `--benchmark-profile webbench`.
- Override modes explicitly when needed: `--modes full-evidence,fast-explore`.

Prompt-variant and memory-isolated run:
`npm run ab:experiment -- --spec ./bench/scenarios/specs/supervisor-ab-webbench.json --memory --memory-isolation per-run --prompt-file ./bench/scenarios/prompts/baseline-system.txt --out ./agent-results/ab-exp-prompts`

Outputs:
- `summary.json` with Wilson CIs and bootstrap delta CI.
- `runs.csv` and `passrate-series.csv` for graphing.
- `summary.md` quick report.
- `cleanPassRate` metrics (blocker-adjusted) and blocker counts per arm.

Research context:
- competitor analysis and direction memo: [../../docs/research/competitor-analysis-2026-03.md](../../docs/research/competitor-analysis-2026-03.md)

## Tier1 Reliability Gate (Deterministic)

Run strict local-fixture gating:
`npm run bench:tier1:gate -- --out ./agent-results/tier1-local --model gpt-5.2 --min-full-pass-rate 1 --min-fast-pass-rate 1`

Outputs:
- `tier1-gate-summary.json`
- `tier1-gate-summary.md`

## Failure Taxonomy + Leaderboard

Classify failures from any run bundle:
`pnpm reliability:scorecard -- --root ./agent-results/ab-exp-staging --out ./agent-results/ab-exp-staging/reliability-scorecard.json --md ./agent-results/ab-exp-staging/reliability-scorecard.md`
