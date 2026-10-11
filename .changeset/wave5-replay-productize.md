---
"@tangle-network/browser-agent-driver": patch
---

Replay productization (minimal): trajectories record a route-normalized start path (minted-ID segments compare as ':id') and replay matching can require the same route shape; BAD_MEMORY_DIR env override for the trajectory cache dir (CI artifact convention); replay outcomes land in run metrics (AgentResult.replay — attempted/outcome/steps/llmCallsUsed).
