---
'@tangle-network/browser-agent-driver': minor
---

Add opt-in zero-LLM workflow replay (`--replay`).

When a successful trajectory has been recorded for a goal+origin, `--replay` re-runs it step-by-step through the driver with **no `brain.decide` LLM calls** — each step guarded (the recorded `@ref` must still exist, the URL/origin must be consistent) and the action's effect re-verified with the existing effect-verification. The instant a step drifts (ref gone, effect fails, execution errors) it **self-heals**: aborts to the live agent loop from the current state, so the outcome is never worse than running from scratch. A single goal-verification call at the end ensures replay never claims success blindly. Default off.

Measured (claude-code, single-step task): a recorded run at `decideLlmCalls: 2` / 30s replays at `decideLlmCalls: 0` / 11s, completing + verifying. Self-heal validated across no-candidate, effect-failure, and execute-failure cases.
