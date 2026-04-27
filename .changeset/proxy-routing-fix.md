---
'@tangle-network/browser-agent-driver': patch
---

fix(brain): gpt-5.x via OpenAI-compatible proxy now works; was 0/30 → 60% on WebVoyager-30

Two production-blocking bugs surfaced by the bad-app landing-page validation harness:

1. `src/brain/index.ts:589` set `forceReasoning: true` for every `gpt-5.x` model with `provider=openai`. This routes the AI SDK to OpenAI's Responses API (`/v1/responses`). Most third-party OpenAI-compatible proxies (router.tangle.tools, LiteLLM, Together, etc.) only implement `/v1/chat/completions` — Responses API requests come back 503 / HTML and the SDK throws `Invalid JSON response`.

2. `scripts/run-{mode-baseline,scenario-track}.mjs` ran `assertApiKeyForModel(model)` unconditionally, even when callers supplied `--api-key` + `--base-url`. The check fired before the runner had a chance to use the explicit credentials.

Fixes:
- New `Brain.isProxiedOpenAI(providerName)` predicate. Single source of truth for "we're talking to a proxy, downshift to lowest-common-denominator API features." Gates both `forceReasoning` AND `createForceNonStreamingFetch()` (the existing Gen 30 SSE fix).
- Skip `assertApiKeyForModel` when `--api-key`/`--base-url` are supplied.
- New `tests/brain-proxy.integration.test.ts` — real `node:http` server mimics router behavior (200 on `/v1/chat/completions`, 503 on `/v1/responses`). Asserts requests hit the right endpoint with `stream: false`. No mocks; +4 tests.

WebVoyager validation results (curated-30, gpt-5.4, router.tangle.tools/v1):
- Before: 0/30 (every case fails at turn 0 with `Invalid JSON response`)
- After: 18/30 = 60.0% (12 remaining failures are 10× `cost_cap_exceeded` and 2× 120s timeout — configuration-bound, not brain bugs)

Total tests: 1514 (+4).
