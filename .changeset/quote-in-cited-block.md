---
"@tangle-network/browser-agent-driver": patch
---

Goal verification (#177): a requirement's quote must appear in the evidence block it cites. Before, a quote found in any block passed, so text the agent itself wrote into an action (an extract query such as `contains: "Logged in as tomsmith"`, or a to-do it typed) could confirm a requirement the verifier attributed to the final page.
