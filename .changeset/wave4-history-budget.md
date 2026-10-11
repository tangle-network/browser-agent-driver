---
"@tangle-network/browser-agent-driver": patch
---

Token-aware history tail: the prefix-stable history now materializes on a character budget (20k chars) in addition to the 8-message cap, so extraction runs with 8-24k-char user messages no longer re-read ~30k tokens of intact history per decide call (measured on wave-3 wikipedia/dashboard-extract artifacts). The freshest pair always stays intact; lean interaction runs keep the wave-2 behavior. Also: Google decide output cap raised to 4096 (Gemini thinking counts against maxOutputTokens and starved the visible JSON at 2000 — the wave-3 hn rep2 malformed-JSON turns), and extraction rules now require short runScript payloads.
