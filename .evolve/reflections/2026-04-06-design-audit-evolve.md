# Reflect: Design Audit Evolve System
Date: 2026-04-06
Project: browser-agent-driver (bad CLI)
Commit: 121e247 — `feat: design audit evolve system with agent dispatch`
Published: @tangle-network/browser-agent-driver@0.12.0

## Run Grade: 8.5/10

| Dimension | Score | Evidence |
|---|---|---|
| **Goal achievement** | 9/10 | All 5 stated goals delivered: vibecoded profile, upgraded prompts, CSS fix generation, evolve loop with agent dispatch, benchmark corpus. Calibration passed on 5/5 world-class sites. |
| **Code quality** | 8/10 | 635 tests still pass, build + boundary checks clean. Single commit, well-scoped. The agent dispatch uses execSync which blocks — could be async. The `SpawnSyncReturns` import is unused. |
| **Efficiency** | 8/10 | 1 session, 1 commit, 1825 lines added. Initial calibration runs hit timeouts (LLM timeout too low at 60s, max_tokens too low at 4000) — required 2 iterations to fix. Could have anticipated this from the prompt size increase. |
| **Self-correction** | 9/10 | Timeout and max_tokens issues diagnosed and fixed within the same session. Anthropic.com went from 0/10 (timeout) → 5/10 (truncated output) → 8/10 (correct) through iterative fixes. |
| **Learning** | 8/10 | Calibration data validates the prompt design. Evolve state persisted. But no formal experiment logged to `.evolve/experiments.jsonl`. |
| **Overall** | 8.5/10 | Feature-complete, tested against production sites, published. Two rough edges: agent dispatch untested end-to-end, CSS injection evolve not tested live. |

## Session Flow Analysis

1. **Evaluate external tool → Build decision**
   - Trigger: User asked about kevinrgu/autoagent
   - Steps: Parallel research (explore codebase + fetch repo)
   - Outcome: Correctly rejected — zero overlap with design audit use case. Only transferable idea (self-improvement loops) already existed in the research pipeline.
   - Time well spent: 2 minutes of research saved hours of wrong-direction work.

2. **Audit existing → Identify gaps → Build incrementally**
   - Trigger: `/evolve` invocation on design audit capabilities
   - Steps: Read all 4 key files → identify 5 gaps → implement sequentially with compilation checks between each
   - Outcome: Clean 5-task execution, all gates passing at each step
   - Pattern: Read-before-write discipline prevented rework.

3. **Calibration-driven prompt tuning**
   - Trigger: Need to verify scoring calibration
   - Steps: Run 6 sites in parallel → diagnose failures → fix infra (timeout, max_tokens) → re-run → confirm calibration
   - Outcome: 5/5 world-class sites correctly scored 8-10. OpenAI correctly scored 2/10 (Cloudflare page).
   - Key insight: The prompt quality is high but fragile to infrastructure — vision LLM calls need generous timeouts and token budgets.

4. **User-driven API simplification**
   - Trigger: "I think we only need --evolve=claude-code not 2 params"
   - Steps: Consolidated `--evolve` + `--evolve-agent` into single `--evolve <mode>` param
   - Outcome: Cleaner CLI, `--project-dir` defaults to cwd
   - Pattern: User has good taste for API surface. Trust their simplification instincts.

## What Worked

1. **Parallel subagent dispatch for research.** Exploring the codebase and fetching the autoagent repo simultaneously saved wall-clock time and gave a complete picture before any code was written.

2. **Calibration-first development.** Running against real sites (Stripe, Linear, Apple, Anthropic, Airbnb) immediately after building proved the system works. The failures (timeouts, truncation) were caught and fixed in the same session.

3. **Incremental compilation checks.** Building after each task caught issues early. No large-batch debugging needed.

4. **Profile-specific rubrics.** The vibecoded profile's template detection ceiling (score cap at 4 for unmodified component libraries) is a concrete, enforceable design opinion — not vague guidance.

## What Didn't Work / Risks

1. **Agent dispatch is untested end-to-end.** The `runAgentEvolveLoop` function was built and compiles, but was never run against a real project. The `execSync` call, prompt formatting, and hot-reload wait are all assumptions. **Risk: first real use will likely surface issues.**

2. **CSS injection evolve not tested live either.** Same situation — `runEvolveLoop` compiles but wasn't exercised against a running dev server in this session.

3. **LLM output parsing is fragile.** The audit prompt asks for a complex JSON structure (score + summary + strengths + designSystemScore + findings with cssSelector/cssFix). If the LLM truncates or formats differently, fields silently fall back to defaults. The Anthropic.com 5/10-with-0-findings result proved this — the LLM ran out of tokens mid-JSON.

4. **execSync blocks the event loop.** Agent dispatch uses synchronous child process execution with a 5-minute timeout. For a CLI this is acceptable, but it means no progress reporting during the agent's work. Should be `spawn` with streaming output.

5. **No test coverage for new code.** 635 tests pass, but zero new tests were added for: the evolve loop, agent dispatch, reproducibility mode, vibecoded profile parsing, design system score parsing. All tested manually via CLI runs.

## Architectural Observations

**The design audit is now the most sophisticated feature in bad.** At ~1800 lines in `cli-design-audit.ts`, it's larger than the core agent runner. The file handles:
- Page discovery (BFS crawl)
- Screenshot capture
- LLM vision analysis
- Design token extraction (pure DOM)
- Report generation
- CSS injection evolve loop
- Agent-dispatched evolve loop
- Reproducibility testing

This is approaching the point where it should be split into modules (`design/audit.ts`, `design/evolve.ts`, `design/tokens.ts`). Not urgent but worth noting.

**The agent dispatch architecture is extensible.** The `AGENT_COMMANDS` record makes adding new agents trivial — just add a command builder function. The custom command fallback (`--evolve "aider --message"`) covers edge cases.

## Product Signals

1. **Design audit as a service.** The prompt quality and calibration results suggest this could be a standalone product. Vibecoded apps are proliferating — developers using Cursor/v0/bolt would pay for automated design feedback with CSS fixes. The `--evolve claude-code` mode is essentially "hire a design engineer for 2 minutes."

2. **Benchmark corpus as a standard.** The `bench/design/corpus.json` with expected score ranges could become a shared calibration standard for design audit tools. "Does your design audit agree that Stripe is 8-10?"

3. **Template detection is valuable.** The vibecoded profile's ability to detect unmodified shadcn/MUI/Ant templates fills a real gap. No existing tool does this well.

## Action Items (ordered by impact)

1. **Test agent dispatch end-to-end.** Run `--evolve claude-code --project-dir ~/webb/starter-foundry` on an actual generated scaffold with a dev server running. Fix whatever breaks.
2. **Add unit tests for evolve and parsing.** At minimum: designSystemScore parsing, cssSelector/cssFix extraction, evolve convergence logic, agent command resolution.
3. **Split cli-design-audit.ts.** Extract token extraction, evolve loops, and report generation into separate modules.
4. **Make agent dispatch async.** Replace `execSync` with `spawn` and stream agent output in real-time when `--debug` is set.
5. **Add Cloudflare bypass.** Sites behind bot protection (OpenAI, likely others) need stealth mode. The design audit should optionally use patchright like the main agent does.
