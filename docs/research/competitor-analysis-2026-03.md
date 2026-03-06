# Browser-Agent Competitive Analysis (2026-03)

Purpose: keep a durable, repo-local record of what strong external browser-agent systems are doing well, where they are weak, and which ideas are worth copying into `agent-browser-driver`.

## Bottom Line

`agent-browser-driver` should not be replaced by a third-party agent framework.

It should copy the strongest proven techniques from the market while preserving its own advantages:
- tight Playwright control
- benchmark discipline
- artifact-first evaluation
- configurable recovery/supervision loop
- local and CI-friendly reproducibility

Best path forward:
1. Strengthen the recovery/control loop, not just the worker prompt.
2. Treat every improvement as a measurable challenger in seeded A/B runs.
3. Use external agents as baselines and fallback executors, not as the product core.

## Systems Reviewed

### OpenAI BrowseComp

Sources:
- https://openai.com/index/browsecomp/
- https://cdn.openai.com/pdf/5e10f4ab-d6f7-442e-9508-59515c65e35d/browsecomp.pdf

What matters:
- Strong evidence that browser-task performance benefits from more test-time compute.
- Aggregation and repeated attempts can materially improve hard-task completion.
- This is a benchmark/eval lesson more than a product-architecture lesson.

What to copy:
- Confidence-aware repeated evaluation on hard tasks.
- Selective best-of-N or retry budget only on difficult cases, not everywhere.

What not to copy blindly:
- Expensive broad best-of-N everywhere. It increases cost quickly and can hide poor default policy quality.

### Magnitude Browser Agent

Sources:
- https://github.com/magnitudedev/browser-agent
- https://docs.magnitude.run/advanced/roles
- https://docs.magnitude.run/advanced/memory

What matters:
- Vision-first posture. They treat page pixels as first-class context, not just text snapshots.
- Explicit role splitting. Separate model roles are used for navigation/verification-style work.
- Caching and memory are used to reduce repeated work and improve iteration speed.
- Strong benchmark marketing around WebVoyager and browser-agent testing.

What to copy:
- Vision in the control loop, not only in the main worker.
- Cleaner role decomposition between worker, supervisor, and evaluator.
- Memory/caching only when isolated and measurable.

Risks:
- Benchmark claims are not the same as stable product reliability.
- Role-splitting helps only if orchestration overhead stays under control.

### browser-use

Sources:
- https://github.com/browser-use/browser-use
- https://docs.browser-use.com/customize/hooks
- https://docs.browser-use.com/customize/browser/authentication

What matters:
- Strong product ergonomics around browser/session/auth persistence.
- Hooks make it easy to instrument or modify agent behavior.
- Good operational story for persistent profiles and authenticated runs.

What to copy:
- First-class auth/profile handling.
- Hook points around decisions, actions, and artifacts.
- Better operator ergonomics for long-running or authenticated flows.

Risks:
- Broad framework surface can add complexity without directly improving pass rate.
- Good cloud/session UX does not automatically imply a stronger decision policy.

### Browserable

Sources:
- https://github.com/browserable/browserable
- https://docs.browserable.ai/quickstart

What matters:
- More control-plane oriented than agent-policy oriented.
- Useful reference for multi-tenant orchestration, task APIs, and self-hostable operations.

What to copy:
- Only the control-plane ideas we actually need for reproducible experiments and remote execution.

What not to copy blindly:
- Large orchestration surface area before the core agent policy is strong.

## Why Not Use Them Directly

Direct adoption would trade away too much control:
- harder apples-to-apples evaluation across our benchmark tiers
- weaker control over artifacts, traces, and research outputs
- tighter coupling to external abstractions we do not own
- less direct alignment with our worker/sandbox/R2-style runtime model

Use them directly for:
- baseline comparisons
- regression reality checks
- executor plug-ins later if they clearly win on a subset of tasks

Do not use them directly as the product core unless they outperform our stack on our benchmark tiers with reproducible evidence.

## Current ADB Assessment

### What ADB already does well

- Strong artifact and eval orientation.
- Good separation between deterministic gates, staging/auth flows, and public-web research tracks.
- Existing seeded A/B framework is the right foundation for closed-loop improvement.
- Page snapshot model is robust and selector-safe.

### Where ADB is weak

- Supervisor/recovery has been under-informed compared with the main worker.
- Prompt and policy variants are still less structured than they should be.
- Auth/profile ergonomics are weaker than the best external tools.
- We still lack enough benchmark breadth and enough repeated runs to claim strong external competitiveness.

### Biggest anti-pattern to avoid

Prompt thrash without evaluation discipline.

If a change is not tied to a challenger config, seeded run set, and confidence-aware comparison, it is not research; it is guesswork.

## Research Gaps Competitors Are Not Solving Well

These are the highest-value areas where there is still room to win:

### 1. Supervisor-guided recovery with real context

Most systems focus on the main planner. Hard failures often come from poor recovery once the agent is already in trouble.

Opportunity:
- stronger stall detection
- vision-aware supervisor
- targeted intervention policies
- escalation rules instead of blind retries

### 2. Reproducible online improvement loop

Many systems demo well but do not expose a clean, scientific improvement workflow.

Opportunity:
- seeded challenger specs
- fixed benchmark slices
- clean delta CI gates
- one-variable-per-cycle promotion rules

### 3. Tiered reliability instead of one blended score

Public-web benchmark numbers hide product truth.

Opportunity:
- Tier 1: deterministic local reliability
- Tier 2: staging/auth business-critical flows
- Tier 3: open-web generalization

This keeps the product honest and avoids optimizing for leaderboard noise.

### 4. Optional hard-mode compute

BrowseComp-style extra compute is valuable, but only on tasks that justify it.

Opportunity:
- default cheap policy
- escalate to harder search/aggregation only when stall probability is high
- keep cost bounded and explicit

## Immediate Product Decisions

These should be treated as current product direction, not brainstorms.

1. Keep `agent-browser-driver` as the core execution/eval engine.
2. Make the supervisor vision-aware when screenshots exist.
3. Add cleaner experimentable policy profiles instead of ad-hoc prompt edits.
4. Improve auth/profile persistence and seeded user-state handling.
5. Integrate external agents later as benchmark baselines, not as replacements.

## Implementation Backlog

### Now

1. Vision-aware supervisor with explicit `supervisor.useVision`.
2. Competitor-informed research doc in-repo.
3. Challenger specs that isolate supervisor-policy changes from unrelated variables.

### Next

1. Prompt/profile registry for worker + supervisor variants.
2. Better auth-state and browser-profile workflows.
3. Research-viz improvements for paired A/B confidence reporting and artifact browsing.

### Later

1. Selective best-of-N / retry aggregation on hard cases only.
2. External-executor harness for baseline comparison against third-party agents.
3. Broader benchmark suite across WebBench, WebVoyager-style tasks, and owned staging flows.

## Decision Rule

Ship only improvements that satisfy all three:
- non-regressive on Tier 1 / Tier 2
- positive clean-delta confidence signal on targeted experiments
- no material artifact-quality regression
