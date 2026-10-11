---
"@tangle-network/browser-agent-driver": patch
---

Sub-call model routing (Alumnium pattern): `BAD_SUBCALL_MODEL` routes goal-verification calls to a cheaper model (e.g. gemini-2.5-flash-lite) while decide stays on the primary. Default is the primary model; adoption as default requires a bench arm showing pass rate holds.
