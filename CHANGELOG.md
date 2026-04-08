# @tangle-network/browser-agent-driver

## 0.16.0

### Minor Changes

- [#42](https://github.com/tangle-network/browser-agent-driver/pull/42) [`a343913`](https://github.com/tangle-network/browser-agent-driver/commit/a343913d474f107a776429599a75b37a1fee0df5) Thanks [@drewstone](https://github.com/drewstone)! - Gen 5 — Open Loop. Three coordinated pillars sharing one TurnEventBus primitive that make the agent transparent and customizable from outside the package.

  **Pillar A — Live observability (`bad <goal> --live`)**

  - New `TurnEventBus` in `src/runner/events.ts` emits sub-turn events at every phase boundary (turn-start, observe, decide, decide-skipped-cached, decide-skipped-pattern, execute, verify, recovery, override, turn-end, run-end).
  - New `src/cli-view-live.ts` SSE server with `/events` (replay-on-connect + 15s heartbeat) and `/cancel` POST → SIGTERM via AbortController.
  - `bad <goal> --live` opens the viewer and streams every event in real-time. After the run completes the viewer stays open for scrubbing until SIGINT.

  **Pillar B — Extension API for user customization**

  - New `BadExtension` interface with five hooks: `onTurnEvent`, `mutateDecision`, `addRules.{global,search,dataExtraction,heavy}`, `addRulesForDomain[host]`, `addAuditFragments[]`.
  - Auto-discovers `bad.config.{ts,mts,mjs,js,cjs}` from cwd; explicit paths via `--extension <path>`.
  - User rules land in a separate slot AFTER the cached `CORE_RULES` prefix so they don't invalidate Anthropic prompt caching.
  - `mutateDecision` runs after the built-in override pipeline so user extensions get the final say. Errors are caught and logged — broken extensions cannot crash the run.
  - Full guide at `docs/extensions.md` with worked examples (Slack notifications, safety vetoes, per-domain rules, custom audit fragments).

  **Pillar C — Lazy decisions (skip the LLM when you can)**

  - New in-session `DecisionCache` (bounded LRU + TTL, key includes snapshot hash + url + goal + last-effect + turn-budget bucket). Cache hits short-circuit `brain.decide()` entirely. Disable via `BAD_DECISION_CACHE=0`.
  - New deterministic pattern matchers for cookie banners (single Accept) and single-button modals (Close/OK). Match → execute action without an LLM call. Disable via `BAD_PATTERN_SKIP=0`.
  - `analyzeRecovery` is now lazy — only fires when there's an actual error trail. Used to run unconditionally every turn.
  - Cache hits and pattern matches emit `decide-skipped-cached` / `decide-skipped-pattern` events on the bus so the live viewer (and user extensions) can audit which turns paid for the LLM and which didn't.

  **Tests:** 830 passing (was 758, +72 net new). Tier1 deterministic gate maintains 100% pass rate. New test files: `runner-events.test.ts` (15), `decision-cache.test.ts` (15), `deterministic-patterns.test.ts` (11), `extensions.test.ts` (24), `cli-view-live.test.ts` (7).

## 0.15.0

### Minor Changes

- [#40](https://github.com/tangle-network/browser-agent-driver/pull/40) [`72c4e25`](https://github.com/tangle-network/browser-agent-driver/commit/72c4e2572553fa30789a1dc3d2cbd1dde8112ba2) Thanks [@drewstone](https://github.com/drewstone)! - Gen 4 — Agent loop speed pass. Six coordinated infrastructure changes targeting wait/observe/connection slack:

  - Drop unconditional 100ms wait in `verifyEffect`; replace with conditional 50ms only for click/navigate/press/select.
  - Run the post-action observe in parallel with the 50ms settle wait (was strictly serial).
  - Skip the post-action observe entirely on pure wait/scroll actions with no expectedEffect (cachedPostState short-circuit).
  - Cursor overlay (`showCursor: true`) no longer waits 240ms after `moveTo` — the CSS transition runs alongside the actual click, reclaiming ~12s on a 50-turn screen-recording session.
  - New `Brain.warmup()` fires a 1-token ping in parallel with the first observe so turn 1's TLS+DNS+model cold-start (~600-1200ms) lands before `decide()` runs. Skipped for CLI-spawning providers (codex-cli, claude-code, sandbox-backend) and via `BAD_NO_WARMUP=1`.
  - Anthropic prompt caching: `brain.decide` now ships system prompts as a `SystemModelMessage[]` with `cache_control: ephemeral` on the byte-stable CORE_RULES prefix when `provider: anthropic`. Subsequent turns get a 90% input discount + faster TTFT on the cached chunk. Other providers continue to receive a flat string (no behavior change).
  - `Turn` records gain `cacheReadInputTokens` / `cacheCreationInputTokens` for prompt-cache observability.

  Tests: 758 passing (was 748). New: `brain-system-cache.test.ts` (5), `brain-warmup.test.ts` (5). Tier1 deterministic gate passes in both modes; absolute deltas are within the noise floor of the 5-turn scenarios. See `.evolve/pursuits/2026-04-07-agent-loop-speed-gen4.md` for the full pursuit spec and honest evaluation.

## 0.14.5

### Patch Changes

- [`b400c1d`](https://github.com/tangle-network/browser-agent-driver/commit/b400c1d4f0c7002cbc4a62e5cc614d51c5ae50b2) Thanks [@drewstone](https://github.com/drewstone)! - Changesets workflow now triggers publish-npm.yml via `gh workflow run` instead of trying to publish inline. The npm trusted publisher is linked to publish-npm.yml's filename, so OIDC tokens generated by changesets.yml were rejected as a workflow_ref mismatch (404s on the publish PUT). Cross-workflow `workflow_dispatch` invocation via GITHUB_TOKEN is allowed (the downstream-trigger restriction only blocks `push` events), so the chain runs end-to-end with no PAT or App token. Future releases: merge the auto-opened "Release: version packages" PR. That's it. No tag re-push, no NPM_TOKEN, no manual intervention.

## 0.14.4

### Patch Changes

- [`36027b9`](https://github.com/tangle-network/browser-agent-driver/commit/36027b95cbde08a62c869617c90f188967fa896e) Thanks [@drewstone](https://github.com/drewstone)! - Release flow now publishes end-to-end in a single workflow run with zero manual steps. The Changesets workflow opens the version PR, then on merge runs build + tag + npm publish via OIDC trusted publishing in the same job. No more manual `git push origin browser-agent-driver-vX.Y.Z` after merging the release PR. publish-npm.yml stays as a manual fallback for re-publishing failed releases via workflow_dispatch.

## 0.14.3

### Patch Changes

- [`60a6c44`](https://github.com/tangle-network/browser-agent-driver/commit/60a6c4487a35ded8943d8c6fd73f7a7dbb69972e) Thanks [@drewstone](https://github.com/drewstone)! - Switch the publish workflow to `npx -y npm@11` and drop the NPM_TOKEN fallback. Node 22's bundled npm 10.x has incomplete OIDC trusted-publisher support for scoped packages and silently 404s the publish PUT. npm 11.5+ has the full OIDC publish path. Each release is now authenticated purely via short-lived GitHub OIDC tokens validated against the trusted publisher on npmjs.com — no long-lived secrets in the repo.

## 0.14.2

### Patch Changes

- [`59b296d`](https://github.com/tangle-network/browser-agent-driver/commit/59b296d470c813940616c7923431eb1cb7899554) Thanks [@drewstone](https://github.com/drewstone)! - Switch npm publish to OIDC trusted publishing. Each release is now authenticated via a short-lived GitHub OIDC token instead of a long-lived `NPM_TOKEN` secret, validated against the trusted publisher configured on npmjs.com. Every publish is cryptographically tied to the exact GitHub commit + workflow run that built it, with provenance attestation visible on the npm package page. Also fixes the `release-tag` script to push the prefixed `browser-agent-driver-v*` tag the existing publish workflow expects, so the next release runs end-to-end with zero manual intervention.

## 0.14.1

### Patch Changes

- [`7c8e2cd`](https://github.com/tangle-network/browser-agent-driver/commit/7c8e2cde5197d8b756cb241523a8cd2e96d7d64d) Thanks [@drewstone](https://github.com/drewstone)! - Fix `provider.chat()` routing for OpenAI-compatible endpoints (Z.ai, LiteLLM, vLLM, Together, OpenRouter, Fireworks). `@ai-sdk/openai` v3+ defaults to the OpenAI Responses API which most third-party endpoints don't implement, causing 404s. Both the new `zai-coding-plan` provider and the default `openai` provider now explicitly use the chat-completions path.
