---
"@tangle-network/browser-agent-driver": patch
---

chore: repo slimming — removed superseded bench pipelines (bench/scenarios, bench/external, bench/webbench, tier-gate/local-reliability/research scripts), the April `.evolve/` program journal, stale `.claude/commands` runbooks, and the installable skills prompt packs (`skills:install`). Runtime skills data (`skills/macros`, `skills/domain`) is unchanged and now explicitly listed in the npm `files` array so it ships with the package. README rewritten with current (2026-10-11) benchmark numbers; new `examples/` directory. Everything removed remains in git history.
