---
"@tangle-network/browser-agent-driver": patch
---

Freeze the composed system prompt per run (default prompt path): conditional rule groups previously flipped with page content mid-run (e.g. search rules appearing/disappearing), busting prompt caching and splitting explicit cache entries in two. Frozen on first decide, cleared on reset; extension/domain/macro rules stay dynamic.
