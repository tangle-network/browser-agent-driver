---
'@tangle-network/browser-agent-driver': minor
---

Gen 4 — Agent loop speed pass. Six coordinated infrastructure changes targeting wait/observe/connection slack:

- Drop unconditional 100ms wait in `verifyEffect`; replace with conditional 50ms only for click/navigate/press/select.
- Run the post-action observe in parallel with the 50ms settle wait (was strictly serial).
- Skip the post-action observe entirely on pure wait/scroll actions with no expectedEffect (cachedPostState short-circuit).
- Cursor overlay (`showCursor: true`) no longer waits 240ms after `moveTo` — the CSS transition runs alongside the actual click, reclaiming ~12s on a 50-turn screen-recording session.
- New `Brain.warmup()` fires a 1-token ping in parallel with the first observe so turn 1's TLS+DNS+model cold-start (~600-1200ms) lands before `decide()` runs. Skipped for CLI-spawning providers (codex-cli, claude-code, sandbox-backend) and via `BAD_NO_WARMUP=1`.
- Anthropic prompt caching: `brain.decide` now ships system prompts as a `SystemModelMessage[]` with `cache_control: ephemeral` on the byte-stable CORE_RULES prefix when `provider: anthropic`. Subsequent turns get a 90% input discount + faster TTFT on the cached chunk. Other providers continue to receive a flat string (no behavior change).
- `Turn` records gain `cacheReadInputTokens` / `cacheCreationInputTokens` for prompt-cache observability.

Tests: 758 passing (was 748). New: `brain-system-cache.test.ts` (5), `brain-warmup.test.ts` (5). Tier1 deterministic gate passes in both modes; absolute deltas are within the noise floor of the 5-turn scenarios. See `.evolve/pursuits/2026-04-07-agent-loop-speed-gen4.md` for the full pursuit spec and honest evaluation.
