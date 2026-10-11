---
"@tangle-network/browser-agent-driver": patch
---

Fix date-widget action failures: @refs whose snapshot name is a doubled accessible name ('Month Month' — the aria-label + labelledby concatenation artifact on Chrome date-editor spinbuttons) previously matched nothing and every action timed out at 30s (the wave-2 form-fill loop burned 12 turns on this). Ref resolution now lazily falls back to the deduped exact name, and the date-picker prompt guidance prefers a single textbox fill with YYYY-MM-DD over typing individual spinbuttons.
