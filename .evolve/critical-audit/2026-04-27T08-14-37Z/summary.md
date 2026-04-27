# Critical audit — `forceReasoning` routes gpt-5.x through unsupported Responses API on third-party proxies

**Score: 4/10.** A production-blocking bug that 1510 unit tests didn't catch because no test exercises the real `provider=openai + baseUrl=<proxy> + model=gpt-5.x` triple against a real HTTP server. The validation infra worked: it surfaced the bug in 6 minutes for ≈$0 (30/30 cases failed `Invalid JSON response`, deterministically).

## Root cause

`src/brain/index.ts:589-598` sets `providerOptions.openai.forceReasoning: true` for any gpt-5.x model with provider=openai. This tells the AI SDK to use OpenAI's **Responses API (`/v1/responses`)**, not chat-completions. `router.tangle.tools/v1/responses` returns HTTP 503 `"LiteLLM proxy not configured"` — it doesn't implement that endpoint. The AI SDK's `generateText` parses the unexpected body and throws "Invalid JSON response", which the brain's per-turn loop reports as "3 consecutive errors" and the runner logs as turn 0 failure.

The Gen 30 fix `createForceNonStreamingFetch()` (line 2794) is irrelevant here — it only rewrites chat-completions bodies, but the SDK isn't sending those when `forceReasoning` is set.

## Fix plan (CRITICAL first)

1. **[CRITICAL]** `src/brain/index.ts:589` — gate `forceReasoning` on `!this.baseUrl`. When routing through a proxy, downshift to plain chat-completions.
   *Action:* See finding 1 in findings.jsonl. Wrap the providerOptions block in `&& !this.baseUrl`.
   *Verification:* New unit test asserting the gate; re-run `npm run validate:landing -- --quick` against router and expect non-zero pass rate.

2. **[HIGH]** `src/brain/index.ts:2794` — extract `isProxiedOpenAI(providerName)` predicate. Both the streaming gate and the forceReasoning gate should reference one source of truth.
   *Action:* New private method on Brain; replace duplicated `provider==='openai' && Boolean(this.baseUrl)` checks.
   *Verification:* Unit test on the predicate.

3. **[HIGH]** No integration test exercises Brain against a real OpenAI-compatible proxy. Both the Gen 30 streaming bug AND this Responses API bug shipped because tests mock the LLM layer.
   *Action:* `tests/brain-proxy.integration.test.ts` with a `node:http` server returning canonically on `/v1/chat/completions` and 503 on `/v1/responses` (mimics router.tangle.tools).
   *Verification:* Regression of #1 OR of `createForceNonStreamingFetch` fails this test deterministically. Real-system test, not a mock.

4. **[MEDIUM]** `scripts/run-mode-baseline.mjs:116` — `assertApiKeyForModel` runs unconditionally; `--api-key` flag should take precedence over `OPENAI_API_KEY` env var.
   *Action:* Skip / parameterize the assertion when `--api-key`/`--base-url` are supplied.
   *Verification:* Invoke with flags + no env var; assertion should not fire.

5. **[MEDIUM]** `tangle-router/litellm/config.yaml` — `/v1/responses` returns 503 with an unhelpful body. Clients can't feature-detect.
   *Action:* Out-of-scope for this repo. File a follow-up issue or PR on tangle-router for explicit 501 + clear message OR explicit Responses API proxy support.
   *Verification:* `curl router.tangle.tools/v1/responses` returns 501 with the documented body.

## Impact assessment

Every `bad` CLI invocation against gpt-5.x via a custom baseUrl is currently broken. This includes:
- Every WebVoyager benchmark run via the production path (the landing-page-validation harness).
- Every bad-app CI/PR run that uses gpt-5.x (currently bad-app's `landing.tsx` advertises `gpt-5.4-mini` via router as the SDK example — so external customers following the example will hit this).
- Every internal evolve/critical-audit cycle that uses gpt-5.x via router.

Fix #1 alone unblocks every gpt-5.x-via-proxy use case. Fixes #2 and #3 are about preventing the next quirk from doing the same thing.

## Dispatch-at-end

**Fix Finding #1 (the one-line gate addition) immediately and re-run `npm run validate:landing -- --quick` to confirm.** That's the single highest-leverage 5-line change available. Then layer in #2 + #3 in the same PR. Then `/critical-audit --reaudit` against this run. **The validation harness from the prior session is the right verification gate** — if the re-run produces a real pass-rate (any non-zero number), the bug is fixed.

If after Fix #1 the validation still produces 0/30, finding #1 was incomplete; do NOT iterate blind — invoke the brain-proxy integration test (#3) first to localize.
