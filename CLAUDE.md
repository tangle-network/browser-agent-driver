# CLAUDE.md

Browser Agent Driver (`bad` CLI) — general-purpose agentic browser automation.

## Gates

Required before merge:
- `pnpm lint` — type-check
- `pnpm check:boundaries` — architecture boundaries
- `pnpm test` — unit + integration (252 tests)
- Tier1 deterministic gate on PRs and `main`
- Tier2 staging gate when secrets available

## Mission

Reliable, performant completion of real user outcomes — for both persona-driven workflows and direct task inputs.

Non-goals: over-specializing for a single app; features without measurable completion gains.

## Defaults

- Model: `gpt-5.4`. Single-model unless `--model-adaptive` is set.
- Wallet mode: only when `wallet.enabled=true` or extension paths provided.
- Evidence: `fast-explore` for iteration, `full-evidence` for release signoff.
- General-purpose first: Tangle personas/hints are optional, never required.

## Experiments

Adaptive routing (`--model-adaptive`), trajectory memory (`--memory`, `--trace-scoring`) stay flagged until non-regressive vs control.

## Benchmark Tiers

- **Tier 1** (deterministic/local): 100% required.
- **Tier 2** (staging/auth): push to 100% through bug closure.
- **Tier 3** (open web): tracked separately; must not regress Tier 1/2.

Track: pass rate, median duration, token usage, artifact completeness.
Promotion: no pass-rate regression + meaningful latency/token improvement.

## Experiment Discipline

1. One variable at a time. Treat each hypothesis as a challenger spec.
2. Fast-explore sweeps first for broad testing. Full-evidence only for shortlisted winners.
3. Seeded AB (`ab:experiment --seed <fixed>`) for reproducibility.
4. Promote only when bootstrap CI lower bound is positive and Tier1/2 gates hold.
5. Memory isolation per run during benchmarks.
6. Stop early on unresolved provider quota/auth issues.
7. Parallelize repetitions within one experiment. One clean experiment at a time for promotion.
8. Keep pushing autonomously until baseline improves, challenger is rejected, or user input is needed.

## Reliability Patterns (Learned)

**Fail fast on terminal blockers:**
- `chrome-error://`, bot challenges, missing API keys → abort immediately with reason.
- API key must match provider (don't let `OPENAI_API_KEY` route to `anthropic`).

**Page interaction:**
- Dismiss cookie/consent dialogs before form submissions. Re-verify action took effect after dismissal.
- Auto-submit search forms (press Enter after typing in `searchbox` role elements).
- Detect A-B-A-B oscillation (menu toggle loops) → redirect to search or direct URL.

**Budget management:**
- Action timeout: `min(30s, caseTimeout/8)` — prevents one stuck click from exhausting the run.
- Snapshot budget: filter decorative elements, 16k char cap on non-first turns.
- First-turn LLM calls must not consume the whole case budget.

**Verification:**
- Verifier sees `budgetSnapshot()`, same as agent (not raw snapshot).
- Rejection feedback escalates: first rejection → navigate to content; second+ → demand strategy change.

**Benchmarks:**
- Separate anti-bot/unreachable sites from core reliability scorecards.
- Supervisor should consume screenshots when available (behind config flag).
- Outer experiment concurrency `1` for promotion-grade studies.

## Rollback

1. Runtime: disable adaptive routing + memory/scoring → control defaults.
2. Wallet: restore legacy activation in `src/browser-launch.ts` if needed.
3. Full: revert feature commit on `main`.

## Roadmap

Canonical in [docs/roadmap/browser-agent-ops.md](docs/roadmap/browser-agent-ops.md).

## Skills

Canonical in `skills/`. Install via `npm run skills:install`.
