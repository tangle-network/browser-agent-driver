---
"@tangle-network/browser-agent-driver": patch
---

Fail-closed on guessed CSS selectors: click/type/fill/hover/select/press/clickSequence actions whose selector appears neither in the current observation, nor in the documented fallback forms (`[data-testid=]`, `[aria-label=]`, `text=`, `role=`), nor in the run's own script/extract results are rejected before execution with the recovery path named (use observed refs/labels or extractWithIndex). Targets the blind-selector loop — the top remaining failure class, burning 260-320k tokens per looping run.
