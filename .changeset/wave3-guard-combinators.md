---
"@tangle-network/browser-agent-driver": patch
---

Tighten the selector guard's documented-fallback match to exact form: combinator selectors with a documented-looking head (`[data-testid="x"] input`) are now rejected with the rule-15 recovery path, closing the gap between prompt guidance and code enforcement. Bare documented selectors (`[data-testid="x"]`, `text=...` with spaces) and observation/evidence-verbatim selectors are unaffected.
