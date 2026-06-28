# Autopsy: Round 4 Raw-Provider Capture Stall

## Run

- Session: `019f0530-f7bf-7c81-b251-17df7a5745ce`
- CWD: `/Users/drew/webb/browser-agent-driver`
- Slice: Generation 31 Round 4, raw-provider capture plus `assertRunCaptured`
- Trace artifacts:
  - `.evolve/autopsies/2026-06-27-codex-last2-traces.md`
  - `.evolve/autopsies/2026-06-27-codex-last2-otlp.jsonl`
  - `.evolve/autopsies/2026-06-27-codex-last2-halo.md`

## Verified Findings

1. The trace analyzer found severe repeated-work symptoms.
   Ground-truth check: `npx -y @tangle-network/traces@0.8.0 analyze --harness codex --last 2 --cwd /Users/drew/webb/browser-agent-driver --out .evolve/autopsies/2026-06-27-codex-last2-traces.md --otlp .evolve/autopsies/2026-06-27-codex-last2-otlp.jsonl` reported 2,755 spans, 3 efficiency findings, and 30 stuck loops.

2. HALO support exists in `@tangle-network/traces`, but HALO did not run here.
   Ground-truth check: the HALO report records `failed: spawn halo ENOENT`, so the deterministic trace findings are the only completed analyzer output.

3. The previous session stalled after a real type/schema mismatch in the partial raw-provider capture implementation.
   Ground-truth check: rerunning `pnpm lint` reproduced `src/brain/agent-eval-capture.ts` errors: `RawProviderEvent` was missing `endpoint`, `baseUrl`, and `redactedFields`.

4. The goal loop amplified the stall instead of containing it.
   Ground-truth check: the session transcript shows 744 token-count events, 729 LLM turns in the OTLP trace, cumulative token usage above 89M, and repeated `git status`, `git diff --check`, `pnpm lint`, `gh pr list`, and `get_goal` calls before zero-token auto-continuation turns.

5. The code bug is fixed in the current worktree.
   Ground-truth check: `pnpm lint`, focused agent-eval and telemetry tests, `pnpm check:boundaries`, and `git diff --check` now pass.

## Classification

**infra-bug.** The direct blocker was an integration bug against the real `@tangle-network/agent-eval` raw-provider schema. The process failure was that the active-goal continuation loop kept expanding context and repeating verification instead of isolating the failing type contract and landing the small fix.

## Learning

- Treat first-party substrate schemas as ground truth. Before wiring raw provider capture, inspect the actual exported event type and test one strict `assertRunCaptured(requireRawCoverageOfLlmSpans: true)` path.
- For long active goals, stop a turn at the smallest failing invariant. Do not keep rerunning broad status, PR, and full verification loops after a deterministic lint/type failure is known.
- `@tangle-network/traces --analyzer halo` requires an external `halo` binary. Record whether HALO actually ran instead of treating support as execution.

## Go-Plan

- Fixed now: raw-provider events include `endpoint`, `baseUrl`, and `redactedFields`; the focused capture test proves strict capture integrity at the Brain provider boundary.
- Next: add a fixture-backed `run-mode-baseline` smoke with `BAD_AGENT_EVAL_CAPTURE_DIR` enabled so benchmark campaigns prove raw capture end to end.

Fix: `src/brain/agent-eval-capture.ts` now writes schema-valid raw provider events, then strict `assertRunCaptured` is covered by `tests/agent-eval-capture.test.ts`.
