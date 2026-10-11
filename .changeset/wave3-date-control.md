---
"@tangle-network/browser-agent-driver": patch
---

Root-fix Chrome date-control failures: the aria snapshot now exposes `input[type=date]` as a single ref'd fillable element (`date "..." [ref=…] (date input — fill with YYYY-MM-DD)`) instead of a `Date` group of unresolvable shadow spinbuttons ('Month Month' — every action on them was a guaranteed 30s timeout, the wave-2/3 form-fill loops). Date refs resolve via getByLabel, and fill with YYYY-MM-DD works natively. Applies to both snapshot pipelines (CDP AX tree and Playwright aria YAML).
