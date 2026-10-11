---
"@tangle-network/browser-agent-driver": patch
---

Prefix-stable conversation history: `compactHistory` rewrote older messages in place every turn as zone boundaries shifted, busting the provider's implicit prefix cache each turn (bad's cache-hit rate ~17% vs browser-use's 36%). The decide path now uses an append-only scheme — an untouched 4-turn tail plus a summary block that materializes once per overflow and only grows by appending. The system prompt is byte-stable across turns: heavy-page rules no longer appear at turn > 10 in the system message; they ride the tail user message instead.
