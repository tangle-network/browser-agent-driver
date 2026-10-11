---
"@tangle-network/browser-agent-driver": patch
---

Explicit Gemini context caching for the decide path: the byte-stable system prompt is cached via the v1beta cachedContents API once per run (keyed by model + content hash, 10-min TTL) and referenced through `providerOptions.google.cachedContent`, with every failure path falling back to the uncached request. Live-verified: 99% cached-read on repeat calls with identical prefixes. Disable with `BAD_GEMINI_CACHE=0`.
