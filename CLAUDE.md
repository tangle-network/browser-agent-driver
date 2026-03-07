# CLAUDE.md

Agent Browser Driver product operating guidance (greenfield, high-ROI, no overengineering).

## Canonical Contract

This file is the contributor operating contract for this project.
Roadmap, benchmark policy, and promotion rules are canonical in:
- [docs/roadmap/browser-agent-ops.md](/Users/drew/webb/agent-browser-driver/docs/roadmap/browser-agent-ops.md)

## Mechanical Enforcement

Required mechanical gates for code changes:
- `pnpm lint` (type-check lint pass)
- `pnpm check:boundaries` (architecture boundary enforcement)
- `pnpm test`
- Tier1 deterministic gate workflow on pull requests and `main`
- Tier2 staging gate workflow on pull requests and `main` when staging secrets are available

No policy-only merge approvals: these checks must pass in CI.

## Reliability Spec Rating

Rating: **9/10**

Why:
- Strong focus on measurable outcomes (pass rate, duration, cost, artifacts).
- Correct promotion rule (no reliability regression).
- Correct separation of default behavior vs experiments.

Gap to 10/10:
- Needs strict, always-on run discipline doc for repeatable daily execution.
- Needs explicit scoped target statement: 100% on defined benchmark tiers.

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
- Default model: `gpt-5.4`.
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

4. Success target:
- Tier 1 (deterministic/local fixtures): 100% required.
- Tier 2 (staging/auth core flows): move to 100% through bug closure.
- Tier 3 (open web variability): tracked separately; not allowed to regress Tier 1/2.

## Recent Lessons (2026-03-04)

1. Terminal blockers must fail fast:
- Detect `chrome-error://` and bot challenges early.
- Abort immediately with explicit reason; do not burn 5-20 turns retrying impossible flows.

2. Benchmark hygiene:
- Auto-load `.env.local` / `.env` in benchmark scripts.
- Fail early when model requires `OPENAI_API_KEY` and key is missing.

3. Dataset discipline:
- Separate unreachable/challenge-gated websites from core reliability scorecards.
- Track them as environment-constraint benchmarks, not core agent capability regressions.

## Recent Lessons (2026-03-05)

1. Provider-key correctness is mandatory:
- API key selection must follow provider (`anthropic` should not pick `OPENAI_API_KEY` by precedence).
- Misrouted keys create false infrastructure failures and invalidate benchmark conclusions.

2. Throughput-first benchmark mode:
- For broad WebBench sweeps, run fast-explore-only first to maximize sample count and CI quality.
- Reserve full-evidence runs for final signoff and artifact capture on shortlisted cases.

3. Control-loop vision matters:
- If the worker can see the page but the supervisor cannot, recovery quality is artificially capped.
- Supervisor should consume screenshot context when available, but remain measurable behind a config flag.

4. Use competitors as baselines, not product substitutes:
- External browser agents are valuable reference systems and benchmark controls.
- Keep core execution, artifacts, and promotion logic inside this repo.

5. WebBench startup reliability:
- If first-turn LLM calls can consume the whole case budget, benchmark conclusions are invalid.
- For broad WebBench sweeps, prefer lower per-call timeouts and fewer retries before changing prompts or policies.
- For promotion-grade GPT-5 WebBench studies, prefer outer experiment concurrency `1` unless a lower-contention calibration run proves otherwise.

## Recent Lessons (2026-03-06)

1. Cookie/consent dialogs intercept form submissions:
- Sites with lazy cookie consent dialogs (John Lewis, many e-commerce) block search/form submissions fired before the dialog is dismissed.
- Deterministic cookie-dialog detection + post-dismissal re-verify guidance prevents wasted turns.
- Always re-check whether the prior action took effect after dismissing any blocking modal.

2. Stealth reach benchmark needs its own case file and repeated data:
- `benchmark-webbench-stealth` is orthogonal to the promoted baseline.
- Anti-bot-prone sites need separate reach tracking, not promotion-grade baseline mixing.
- Page structure issues (hidden search fields, complex navigation menus) are distinct from anti-bot failures.

## Execution Standard

1. Operate as reliability engineering, not feature exploration.
2. Assume failures are fixable engineering defects.
3. Change one variable at a time; always compare against control.
4. Ship only changes that improve or preserve success rate.
5. Run `bench:tier1:gate` before merging reliability changes.
6. Run `bench:classify` on experiment output and prioritize the top failure class.

## Autonomy Standard

1. Default to the next highest-ROI task automatically once the current task or experiment finishes.
2. Do not stop after a single run or a single experiment if the next step is clear and low-risk.
3. After each experiment:
- evaluate the result
- classify the failure or gain
- choose the next best intervention
- run the next experiment without waiting for permission
4. Only stop to ask for input when:
- the next step requires credentials, approvals, or product decisions that cannot be inferred safely
- the repo state is ambiguous or risky
- a blocker cannot be resolved locally with high confidence
5. Prefer a sequence of narrow experiments over one broad speculative change.
6. Keep pushing until one of these is true:
- the promoted baseline is materially better
- the current challenger is clearly rejected
- the next step requires user input

## Cost-First Experiment Order

1. Start with fast-explore-only sweeps for broad hypothesis testing.
2. Promote to dual-mode (`full-evidence,fast-explore`) only for shortlisted winning variants.
3. Never run high-repetition full-evidence sweeps before fast-explore indicates uplift.
4. Treat unresolved provider quota/auth issues as experiment blockers and stop early.
5. For reliability-affecting changes, create an execution plan from `exec-plans/TEMPLATE.md`.
6. Runtime observability must remain on unless there is a measured reason to disable it.

## Closed-Loop Improvement (RL-Style Discipline)

1. Treat each hypothesis as a challenger spec, never as an ad-hoc code tweak.
2. Run seeded AB (`ab:experiment --seed <fixed>`) so repetition ordering is reproducible.
3. Compare by confidence-aware clean delta (bootstrap CI), not point estimate only.
4. Promote only when clean CI lower bound is positive and Tier1/Tier2 gates remain non-regressive.
5. Keep memory isolated per run (`memory-isolation=per-run`) during benchmark experiments.
6. Use `research:cycle` to rank challengers and pick one winner per cycle.

## Parallelism Policy

1. Parallelize inside a single seeded experiment first:
- Use `ab:experiment` concurrency for repetitions/arms.
- Use scenario concurrency only up to the point where browser/network contention does not distort results.

2. Do not run multiple unrelated research cycles in parallel by default:
- It increases token-rate variance, browser contention, anti-bot risk, and result-attribution noise.

3. Outer-loop parallelism is allowed only when all are true:
- same model family and provider quotas are well below limit
- separate output roots and memory scopes are enforced
- target sites do not share auth/session state
- the goal is throughput, not a promotion decision

4. Promotion decisions should come from one clean, controlled experiment at a time.

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
