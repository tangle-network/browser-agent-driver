---
"@tangle-network/browser-agent-driver": patch
---

Sanitize `runScript` payloads: scripts containing `[ref=...]` selectors are rejected with an actionable error (aria-snapshot refs are not DOM attributes — the phantom-ref querySelector loop), and scripts with a bare top-level `return` are auto-wrapped in an IIFE instead of dying on a SyntaxError. The extraction rules now state refs are not DOM attributes.
