---
"@tangle-network/browser-agent-driver": patch
---

Fix Gemini output truncation in the decide loop: zero the thinking budget for Gemini flash models (hidden thinking tokens consumed the 600-token output cap before the JSON body), raise the Google output cap to 2000 (format-hint retry uses the same cap), and reorder the RESPONSE FORMAT schema/examples so `action` is emitted first and truncation can no longer cut the response before the action.
