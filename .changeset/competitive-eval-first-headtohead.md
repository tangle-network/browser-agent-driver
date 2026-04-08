---
'@tangle-network/browser-agent-driver': minor
---

Competitive eval — first head-to-head: bad v0.19.0 vs browser-use 0.12.6 (3 reps × 3 tasks).

**Result:** bad WINS decisively on form-fill (5.9× faster, 8× fewer tokens, 2.4× cheaper) and multi-step product flows (16.3× faster, 9× fewer tokens, 3.5× cheaper). bad LOSES on pure extraction tasks (0% vs 100% pass rate) due to a real architectural bug in the planner that's now tracked as a Gen 7.2 follow-up.

## What ships

- **`bench/competitive/adapters/_browser_use_runner.py`** — Python bridge that runs `browser_use.Agent` against any task URL, captures token usage by monkey-patching `ChatOpenAI.ainvoke`, and writes a `result.json` matching the canonical `CompetitiveRunResult` shape. Page state is captured via an `on_step_end` callback (calling `get_state_as_text` after `agent.run()` returns hangs on session teardown).
- **`bench/competitive/adapters/browser-use.mjs`** — wires the Python bridge into the competitive runner. Detects browser-use via `.venv-browseruse/` or system Python, parses `result.json`, runs the same external oracle every adapter shares, computes cost via the same OpenAI per-token rates the bad adapter uses (so the cross-framework $ comparison is fair).
- **`bench/competitive/tasks/dashboard-extract.json`** — extraction task: read 3 metric cards from `complex.html`, return as JSON. Oracle: `json-shape-match` with regex values matching the fixture's HTML constants.
- **`bench/competitive/tasks/dashboard-edit-export.json`** — multi-step product flow: switch tab → edit row → export. Oracle: `text-in-snapshot` looking for the success message.
- **`docs/COMPETITIVE-EVAL.md`** — full per-task results table, per-architecture analysis, honest caveats, and the cache-hit comparison.
- **`.gitignore`** — excludes `.venv-browseruse/`.

## Verified result (3 reps × 3 tasks × 2 frameworks = 18 cells, gpt-5.2, same machine same day)

| metric | task | bad mean | browser-use mean | Δ% | verdict |
|---|---|---:|---:|---:|---|
| pass rate | form-fill | 100% | 100% | 0 | tied |
| pass rate | dashboard-extract | **0%** | **100%** | — | **browser-use wins (bad planner bug)** |
| pass rate | dashboard-edit-export | 100% | 100% | 0 | tied |
| wall-time | form-fill | 34.8s | 204.8s | +488% | bad **5.9× faster** |
| wall-time | dashboard-extract | 8.3s | 20.6s | +148% | bad faster but wrong |
| wall-time | dashboard-edit-export | 9.3s | 151.5s | +1531% | bad **16.3× faster** |
| total tokens | form-fill | 8,930 | 72,450 | +711% | bad **8.1× fewer** |
| total tokens | dashboard-edit-export | 3,600 | 33,140 | +821% | bad **9.2× fewer** |
| cost per run | form-fill | $0.037 | $0.089 | +138% | bad **2.4× cheaper** |
| cost per run | dashboard-edit-export | $0.013 | $0.046 | +252% | bad **3.5× cheaper** |
| cache-hit | form-fill | 62% | **81%** | — | browser-use uses cache better |

Cohen's d on every wall-time / token / cost metric is "large" (>0.8) — confirming the differences are real signal, not noise. Bootstrap 95% CIs on the deltas cleanly exclude 0 in every case.

## Why bad wins where it wins

- Planner-then-execute (Gen 7) compresses multi-step structured tasks into 1-3 LLM calls. browser-use's per-action loop pays the LLM round-trip latency × N.
- Variance is dramatically lower: bad's wall-time spread on form-fill is 30.6-42.3s (12s); browser-use is 169-239s (70s). The planner makes runs deterministic.

## Why bad loses on extraction (the honest part)

bad's planner generates a 2-step plan: `runScript` to extract values, then `complete` with the result text. But the planner has to commit to the `complete` text BEFORE the `runScript` runs, so it puts placeholder values like `null` or `"<from prior step>"`. The runner emits the placeholder as the run result, the oracle fails the regex match.

This is a real architectural limitation of plan-then-execute for tasks where the final result depends on values observed mid-run. Tracked as a Gen 7.2 follow-up: detect placeholder result patterns and defer the final `complete` to per-action mode via `Brain.decide()` so it can see the runScript output.

## Honest caveats

- **n=3 reps per cell.** Mann-Whitney U p-values are ~0.081 across the board because that's the smallest p achievable with two 3-element samples — the test is power-limited at this sample size. Bootstrap CIs and Cohen's d are more informative here.
- **`text-in-snapshot` oracle false-positive risk for browser-use:** the Python bridge captures final page state via `on_step_end` callback (latest captured state). Calling `get_state_as_text` after `agent.run()` returns hangs on session teardown — that's why we use the callback instead. For workflow tasks like dashboard-edit-export this means the oracle might pass on browser-use even if the actual final state didn't reach the expected text. Bad does NOT have this issue because the bad-adapter reads the actual ARIA snapshot from `events.jsonl observe-completed` events.
- **bad ran with `--config planner-on.mjs`.** Without the planner, bad would look much more like browser-use on form-fill (slower, more LLM calls) but would PASS the extraction task. The architectural trade-off is real.
- **browser-use ran with `use_vision=False, calculate_cost=False, directly_open_url=True`** — closest comparison to bad's startUrl behavior without paying for vision tokens.

## What we'll learn next

1. **Fix the Gen 7.2 planner extraction bug** — the bench will tell us if it works (pass rate goes 0% → 100%).
2. **Investigate browser-use's cache hit advantage** (62% vs 81%). browser-use's per-step prompt is longer and more structured, which caches better. There's headroom to improve bad's planner system prompt for cache-friendliness.
3. **Add `Stagehand` adapter** when Browserbase keys are available, so we have a 3-way comparison.
4. **Add 2-3 more tasks** covering navigation, blocker recovery, and longer flows to broaden the architectural picture.
