---
"@tangle-network/browser-agent-driver": patch
---

New-page snapshot budget 24k -> 12k chars: budgetSnapshot's keep-set (inputs, headings, content lines, then bulk links) already prioritizes decision-relevant content, and truncated serves now carry a windowing note pointing the model at extractWithIndex for off-window text instead of selector guessing.
