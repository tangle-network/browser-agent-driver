---
"@tangle-network/browser-agent-driver": patch
---

Goal-verification cost and conservatism fixes: (a) the verifier LLM call's token usage is now recorded into run metrics (turn totals + a `goal-verification-completed` event) — it was previously invisible in cost accounting; (b) when the run holds SCRIPT RESULT evidence, the verifier skips the fresh 24k-token page snapshot and forced screenshot and judges the embedded evidence instead; (c) a claimed JSON result whose fields all match SCRIPT RESULT values exactly is accepted deterministically with no verifier call (the bench case: correct JSON re-prompted 3×, $0.087 for one pass).
