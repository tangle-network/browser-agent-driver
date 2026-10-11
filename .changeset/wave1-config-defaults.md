---
"@tangle-network/browser-agent-driver": patch
---

Config defaults: `microPlan.maxActionsPerTurn` 2 → 4 (match the multi-action ballpark other harnesses use; the micro-plan safety whitelist still bounds what can chain), and the default vision strategy flips from `always` to `auto` (screenshot-on-demand — the escalation path captures a screenshot only when errors/modals/low turns trigger it), saving ~1-2k input tokens per turn in production runs.
