---
'@tangle-network/browser-agent-driver': minor
---

Gen 5 — Open Loop. Three coordinated pillars sharing one TurnEventBus primitive that make the agent transparent and customizable from outside the package.

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
