---
"@tangle-network/browser-agent-driver": patch
---

Bound context growth per turn: `runScript`/`extractWithIndex` feedback injected into the brain is capped at 1000 chars (the full result stays on the evidence ledger), and history compaction keeps only the freshest user message intact (was 2). A planned zero-diff snapshot suppression was bench-tested and dropped: form fills don't alter the a11y tree, so the "NO CHANGES" stub made the model conclude the page was broken and abort.
