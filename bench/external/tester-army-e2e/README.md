# tester-army/e2e adapter spike

Seam: **suite runner**, not `Driver`. `e2e` (Apache-2.0,
[github.com/tester-army/e2e](https://github.com/tester-army/e2e)) is an
agentic test framework — a test declares NL goals (`agent.act(...)`) checked
by assertions (`agent.assert`, locator `expect`). It owns its agent loop, so
the observe/act `Driver` interface in `src/drivers/types.ts` is the wrong
seam, the same way it is for browser-use. The honest integration is: run an
e2e suite, then land its artifacts in our evidence pipeline.

## What's here

- `e2e.config.ts` — web engine (`@e2e-dev/web`), local zero-spend model via
  Ollama's OpenAI-compatible endpoint (`OPENAI_BASE_URL` /
  `E2E_MODEL` overridable), fixture server for `bench/fixtures/`.
- `tests/form-fill.e2e.ts` — the same multi-step form as
  `bench/competitive/tasks/form-fill-multi-step.json`, expressed as 3 NL
  agent steps + a locator assertion.
- `tests/smoke-fill.e2e.ts` — one-field smoke used to prove the
  record→replay cycle with a weak local model.

## What actually ran (2026-10-10, local Ollama qwen2.5:3b, zero spend)

- `smoke-fill` run 1: **pass**, 9.75s, 3 model calls, 13.0k tokens,
  `Cache 1 missed` (step recorded).
- `smoke-fill` run 2: **pass**, 2.94s, **zero model calls**,
  `Cache 1 replayed` — the agent step replayed deterministically from cache.
- `form-fill` (the full 19-field task): fails with qwen2.5:3b — the 3B model
  cannot drive the full form (4 model calls then ACTION_FAILED on the Next
  tap). Plumbing (suite discovery, agent steps, trace + report artifacts)
  all works; the failure is model capability, not the integration. A
  credentialed model run is a follow-up (no working paid key was available
  in repo config at spike time — see PR body).

## Run

```bash
cd bench/external/tester-army-e2e
npm install            # e2e, @e2e-dev/web, ai, @ai-sdk/openai (out-of-band deps)
E2E_TELEMETRY_DISABLED=1 npx e2e run
```

`e2e run` writes `.e2e/report.json` (machine-readable per-test result with
per-step token counts and cache outcomes) plus traces/screenshots under
`.e2e/`. That report is the artifact our pipeline would ingest; a
`bench/competitive/adapters/tester-army-e2e.mjs` adapter can shell out to
`npx e2e run --reporter json`-style output and map suite pass/fail into the
canonical `CompetitiveRunResult` (not built in this spike — e2e's task model
is "suite of verified steps", which does not map 1:1 onto the single-goal
competitive task schema; see the RFC).

## Replay cache (the feature that matters)

From `node_modules/e2e/docs/cache.mdx`: an `agent.act()` step whose result is
later verified by an assertion is **recorded**; subsequent runs **replay it
with zero model calls** until the app changes. The cache lives on disk under
`.e2e/cache/` (file store, one content-addressed `<sha256>.json` per recorded
step; `cache.dir` in config relocates it). Verified live in this spike:
`npx e2e cache ls` shows the entry with its test, target, and action count;
`npx e2e cache stats` reports entry count and size.
`step.cache.write` in `.e2e/report.json` says what happened to each recording
(`saved` / `kept` / `unconfirmed` / `evicted` / …).

To persist/reuse across our runs: commit or archive `.e2e/cache/` alongside
the suite (it is content-addressed by app state, so stale entries hand off to
the agent automatically rather than failing stale), or point `cache.dir` at
a shared volume in CI. That is exactly the "verified-step replay" gap our
bespoke loop never closed.
