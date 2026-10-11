---
"@tangle-network/browser-agent-driver": patch
---

Extraction-stall escalation: consecutive unproductive extraction attempts (rejected scripts, script errors, empty script results, empty extractWithIndex results) are now counted across strategy switches — the wave-4 15-turn dashboard-extract loop oscillated between runScript and extractWithIndex and the error-based abort ladder reset each time. At 4 misses the model gets a hard-stop directive (complete with available data, navigate, or abort).
