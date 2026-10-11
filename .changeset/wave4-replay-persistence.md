---
"@tangle-network/browser-agent-driver": patch
---

Verified-step replay spike fixes: recorded trajectories now exclude read-only steps (runScript/extractWithIndex/evaluate/verifyPreview — replaying them produces no state change, so their recorded expectedEffect healed otherwise-perfect replays), and the replay controller settles 1.5s before the final verification (async UI updates at browser-I/O replay speed). Spike proof on the dashboard-edit-export fixture: live run 5 turns / \$0.015; replay run: zero decide calls, one goal-verification call, pass in 8s.
