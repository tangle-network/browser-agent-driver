---
"@tangle-network/browser-agent-driver": patch
---

Final-turn guarantees: the runner now auto-completes from the most recent `SCRIPT RESULT` evidence when the model spends its last turn on a non-terminal action (previously the run died at max turns with the answer already extracted), and `decide()` replaces the prose final-turn hint with a terminal-only response schema (complete/abort are the only valid answers).
