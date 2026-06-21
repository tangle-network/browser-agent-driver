---
'@tangle-network/browser-agent-driver': minor
---

design-audit now defaults to the reference-grounded engine when a populated reference corpus is present (previously opt-in via `--reference-grounded`). Without a corpus it stays on the v1 linter audit, so installs that don't ship a corpus are unchanged. The corpus is detected with a plain filesystem check so the v1 path never loads the reference engine. Use `--v1` to force the linter audit when a corpus is present, or `--reference-grounded` / `--reference <page>` to force the grounded engine.
