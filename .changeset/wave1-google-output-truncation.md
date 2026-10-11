---
"@tangle-network/browser-agent-driver": patch
---

Fix Gemini output truncation in the decide loop: raise the Google output cap to 2000 (the format-hint retry uses the same cap) and reorder the RESPONSE FORMAT schema/examples so `action` is emitted first and truncation can no longer cut the response before the action. The Gemini thinking budget stays at the API default — bench isolation showed zeroing it degraded recovery reasoning and cost more tokens through strategy loops than it saved; `BAD_GOOGLE_THINKING_BUDGET` is available as an A/B override.
