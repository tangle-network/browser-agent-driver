---
"@tangle-network/browser-agent-driver": patch
---

Bound context growth per turn: `runScript`/`extractWithIndex` feedback injected into the brain is capped at 1000 chars (the full result stays on the evidence ledger), history compaction keeps only the freshest user message intact (was 2), and zero-change same-page turns send "NO CHANGES — refs still valid" instead of the full snapshot.
