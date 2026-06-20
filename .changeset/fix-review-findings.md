---
'@tangle-network/browser-agent-driver': patch
---

Address PR review findings on the reference-grounded design audit.

- **Security (high):** the `--evolve --agent` dispatch built a shell string and passed the audit-derived prompt through it, so DOM text mined from a hostile audited page could inject `$(...)`/backtick command substitution. Switched to `execFileSync(cmd, args)` (argv passing, no shell) — the prompt is now a single discrete argument that the shell never evaluates. Added a regression test.
- **Repo hygiene:** removed a raw NUL byte in `embedding-hash.ts` (it made the file binary to git/diff/grep); replaced with the `\0` escape — runtime hash values are identical.
- **Robustness:** `buildRedesignArtifact` now drops an LLM-hallucinated grounding id and warns instead of throwing and crashing the whole audit; the evolve report renders skipped fixes (with reasons) and signs a negative score delta correctly (no more `(+-1.5)`); `clipToWord` handles `max<=1` without dropping a character.
