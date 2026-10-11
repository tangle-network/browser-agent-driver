---
"@tangle-network/browser-agent-driver": patch
---

Raise the goal-verification output cap for Google to 4096: Gemini thinking tokens count against maxOutputTokens, and at 600 the verdict JSON starved and failed to parse — every failed parse is a conservative reject that reprompts the agent (silent cost on live runs since thinking was enabled) and broke replay's single verification call outright.
