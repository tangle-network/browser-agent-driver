---
"@tangle-network/browser-agent-driver": patch
---

Premature-surrender guard: an `abort` with ~zero executed actions and zero extraction evidence on a reachable page is now rejected with a re-prompt pointing at the live observation (element count + extraction actions to try), instead of ending the run — confabulated constraints ("a previous run failed") no longer terminate runs with the data visible. Hard-blocked pages (navigation errors, anti-bot interstitials, access-denied walls) stay abortable, and aborts after genuine attempts are untouched.
