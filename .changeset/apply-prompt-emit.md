---
'@tangle-network/browser-agent-driver': minor
---

Emit a coding-agent apply prompt by default from reference-grounded audits.

A reference-grounded `design-audit` now writes `<slug>.apply-prompt.md` alongside the report and redesign brief — a self-contained implementation prompt a coding agent (Claude Code, Codex, Cursor) reads and runs ITSELF to apply the grounded redesign in its own project. This makes `bad` a tool coding agents call; `bad`-spawns-the-agent (`--evolve --agent <name>`) remains the opt-in alternative, and the default emits without spawning anything.
