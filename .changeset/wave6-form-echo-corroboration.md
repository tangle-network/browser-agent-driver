---
"@tangle-network/browser-agent-driver": patch
---

Multi-literal form-echo corroboration: goal-literal corroboration now also accepts form-control state evidence (payloads of successfully executed fill/select/type actions — driver-confirmed values), and literal matching is case-insensitive but word-boundaried ('other' matches the page's 'Other' label but not 'bother'). Strictness unchanged: every goal literal must be accounted somewhere in the run, and a goal field the agent never attempted correctly stays uncorroborated.
