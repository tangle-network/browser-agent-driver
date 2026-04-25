# Competitive Eval — head-to-head against the field

`pnpm bench:compete` runs `bad` against other browser-agent frameworks (browser-use, Stagehand, …) on a shared task corpus and produces a single statistically-rigorous comparison report.

This is the fourth canonical validation tool alongside `bench:validate`, `ab:experiment`, and `research:pipeline --two-stage` (see [`docs/EVAL-RIGOR.md`](EVAL-RIGOR.md)). Same rigor rules apply: **≥3 reps per cell, no single-run claims, ever.**

## What it measures

For each (framework × task × rep) cell:

| | what | source |
|---|---|---|
| **Quantitative** | wall-time (s), turns, LLM call count, input/output/cached tokens, total tokens, cost ($) | adapter |
| **Quality** | external oracle pass/fail (vs the framework's self-assessment) | shared `_oracle.mjs` |
| **Statistical** | mean, stddev, min/median/p95/max, Wilson CI on pass rate, bootstrap CI on delta-of-means, Cohen's d, Mann-Whitney U, spread-test verdict | `scripts/lib/stats.mjs` |

The **external oracle** is the single most important design choice. Each framework has its own notion of success ("the agent claimed it succeeded"); the oracle re-checks the **same observable state** regardless of which framework ran, so the comparison is fair.

Oracle types (see `bench/competitive/tasks/_schema.json`):
- `text-in-snapshot` — substring must appear in the agent's final ARIA snapshot OR result text
- `url-contains` — substring in the final URL
- `json-shape-match` — every key in `expectedShape` present in the agent's structured result; values matched literally or via `re:` regex strings
- `selector-state` — degraded form of `text-in-snapshot` (a full live-page selector check would require re-launching Playwright after the agent exited)

## Quick start

```bash
# bad-only (no competitor install needed)
pnpm bench:compete -- \
  --frameworks bad \
  --tasks form-fill-multi-step \
  --reps 3 \
  --config bench/scenarios/configs/planner-on.mjs \
  --out agent-results/competitive-bad-only

# head-to-head once browser-use is installed (see Install section below)
pnpm bench:compete -- \
  --frameworks bad,browser-use \
  --tasks form-fill-multi-step \
  --reps 3 \
  --baseline bad \
  --out agent-results/competitive-bad-vs-browseruse
```

### Output

Each run produces:

- `<out>/runs.jsonl` — one JSON line per (framework, task, rep) cell with the full `CompetitiveRunResult` shape
- `<out>/runs.csv` — flat CSV for graphing tools
- `<out>/summary.json` — per-cell descriptive stats + cross-framework deltas with bootstrap CIs / effect sizes / verdicts
- `<out>/comparison.md` — readable markdown report (paste this directly into PRs)
- `<out>/<framework>/<task>/<runId>/...` — per-run raw artifacts (events.jsonl, screenshots, etc.) for forensics

## Rigor rules (same as `bench:validate`)

- `--reps < 3` exits non-zero unless `--allow-quick-check` is passed
- Quick-check runs may NOT be cited in PRs, changesets, or pursuit docs
- The runner reports `mean (min-max), N reps` for every metric
- Spread-test verdict per metric: `win` / `comparable` / `regression` based on whether the delta exceeds the worst-case spread

## Adding a new task

1. Drop a JSON file in `bench/competitive/tasks/<id>.json` matching `_schema.json`
2. If it uses `__FIXTURE_BASE_URL__`, add the HTML file under `bench/fixtures/`
3. Pick the simplest oracle that's deterministic on the agent's final state — `text-in-snapshot` is almost always the right call

## Adding a new framework adapter

Adapters live in `bench/competitive/adapters/<framework>.mjs` and must export:

```js
export const FRAMEWORK_ID = 'my-framework'

/**
 * Detect whether the framework is installed/available.
 * @returns {{ available: boolean, version?: string, reason?: string }}
 */
export function detect(repoRoot) { ... }

/**
 * Run a single task once.
 * @param {object} task   - parsed task JSON
 * @param {object} options - { repoRoot, outDir, fixtureBaseUrl, model, config, runId }
 * @returns {Promise<CompetitiveRunResult>}
 */
export async function runTask(task, options) { ... }
```

The `CompetitiveRunResult` shape (see `bench/competitive/adapters/bad.mjs` for the canonical example):

```js
{
  framework: 'my-framework',
  frameworkVersion: '1.2.3',
  taskId: 'form-fill-multi-step',
  runId: 'my-framework-form-fill-rep001',
  startedAt: ISO8601,
  endedAt: ISO8601,
  success: boolean,             // EXTERNAL ORACLE verdict, not the agent's claim
  oracleVerdict: { passed, reason, detail },
  agentClaimedSuccess: boolean, // what the framework itself reported
  wallTimeMs: number,
  turnCount: number | null,
  llmCallCount: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
  cachedInputTokens: number,
  totalTokens: number | null,
  costUsd: number | null,
  finalUrl: string,
  finalTitle: string,
  resultText: string,           // structured result text the agent emitted
  rawArtifactDir: string,       // for forensics
  errorReason: string | null,
  exitCode: number,
}
```

The `runner.mjs` only depends on this shape — adapters are completely free to use any internal mechanism (Python child process, Docker container, native CLI, etc.).

## Installing competitor frameworks

These are intentionally NOT in `package.json` — competitor SDKs are heavy and not every user will run the cross-framework comparison. Install them out-of-band when you need them.

### browser-use (Python)

```bash
# Requires Python 3.11+ and a virtualenv
python3 -m venv .venv-browseruse
source .venv-browseruse/bin/activate
pip install browser-use playwright
playwright install chromium

# Set provider key (use the same model class as bad for fairness)
export OPENAI_API_KEY=sk-...
```

The adapter (`bench/competitive/adapters/browser-use.mjs`) shells out to a small Python entry script (`bench/competitive/adapters/_browser_use_runner.py`) and parses its JSON output.

### Stagehand (TypeScript / Browserbase)

```bash
# In a side directory or with --no-save
pnpm dlx @browserbasehq/stagehand --version
# OR install locally if you'll use it repeatedly
pnpm add -g @browserbasehq/stagehand

# Set Browserbase key
export BROWSERBASE_API_KEY=bb_...
export BROWSERBASE_PROJECT_ID=...
```

The adapter (`bench/competitive/adapters/stagehand.mjs`) drives Stagehand via its Node SDK in a child process.

### OpenAI Computer Use / Anthropic Computer Use

Use the respective SDKs directly via the provider's `computer_use_preview` tool. Adapters are not yet shipped — both providers' computer-use APIs change quickly and the contract here would need to track them. Pull requests welcome.

## Related-but-different tools (not competitors)

These tools are sometimes confused with `bad` but solve a different layer:

- **[`millionco/expect`](https://github.com/millionco/expect)** — AI agent testing framework. Reads git diffs, generates test plans, runs them in Playwright, reports failures back to the coding agent (Claude Code, Cursor, Copilot, …). It's a *QA productivity layer for AI coding assistants*, not a general-purpose browser agent and not an eval framework. Could conceivably USE something like `bad` underneath instead of raw Playwright. We don't benchmark against it because they don't compete on the same task.

## First head-to-head: bad v0.19.0 vs browser-use 0.12.6 (3 reps × 3 tasks, gpt-5.2, 2026-04-08)

3 tasks × 2 frameworks × 3 reps = 18 cells. All runs on the same machine the same day, same model (`gpt-5.2`), same fixture server. Bad ran with `--config bench/scenarios/configs/planner-on.mjs`. browser-use ran with `use_vision=False, calculate_cost=False, directly_open_url=True` (closest comparison to bad's startUrl behavior).

### Task 1: form-fill-multi-step (19 fields, 3 form steps)

| metric | bad (mean) | browser-use (mean) | Δ | bootstrap CI on Δ | Cohen d | verdict |
|---|---:|---:|---:|---|---:|---|
| pass rate | 100% (3/3) | 100% (3/3) | 0 | — | — | tied |
| wall-time | **34.8s** | 204.8s | **+170s (+488%)** | [134.8, 200.7] | 6.76 (large) | **bad WINS — 5.9× faster** |
| turns | 9.7 | 14.0 | +4.3 (+45%) | [0.3, 7.3] | 1.68 (large) | bad wins |
| LLM calls | **3.0** | 8.3 | +5.3 (+177%) | — | — | **bad WINS — 2.8× fewer** |
| total tokens | **8,930** | 72,450 | +63,520 (+711%) | [59746, 70169] | 15.37 (large) | **bad WINS — 8.1× fewer** |
| cost | **$0.037** | $0.089 | +$0.052 (+138%) | [$0.05, $0.06] | 13.76 (large) | **bad WINS — 2.4× cheaper** |
| cache-hit rate | 62% | **81%** | — | — | — | browser-use uses cache more |

### Task 2: dashboard-extract (read 3 metric cards, return as JSON)

| metric | bad (mean) | browser-use (mean) | Δ | verdict |
|---|---:|---:|---:|---|
| **pass rate** | **0% (0/3)** | **100% (3/3)** | — | **browser-use WINS — bad's planner can't extract** |
| wall-time | 8.3s | 20.6s | bad 2.5× faster (but **wrong**) | browser-use only |
| LLM calls | 1.0 | 3.0 | bad 3× fewer | — |
| total tokens | 3,622 | 19,908 | bad 5.5× fewer (but **wrong**) | — |
| cost | $0.013 | $0.026 | bad 2× cheaper (but **wrong**) | — |

**Why bad fails:** the planner generates a 2-step plan: `runScript` to extract values, then `complete` with the result text. But the planner has to commit to the `complete` text BEFORE the `runScript` runs, so it puts placeholder values like `null` or `"<from prior step>"`. The runner emits the placeholder as the run result, the oracle fails the regex match. **This is a real architectural limitation of plan-then-execute for tasks where the final result depends on values observed mid-run.** Tracked as a Gen 7.2 follow-up.

### Task 3: dashboard-edit-export (multi-step product flow: switch tab → edit row → export)

| metric | bad (mean) | browser-use (mean) | Δ | bootstrap CI on Δ | Cohen d | verdict |
|---|---:|---:|---:|---|---:|---|
| pass rate | 100% (3/3) | 100% (3/3) | 0 | — | — | tied |
| wall-time | **9.3s** | 151.5s | **+142s (+1531%)** | [117.7, 156.5] | 9.36 (large) | **bad WINS — 16.3× faster** |
| turns | 5.3 | 8.7 | +3.3 (+63%) | [2.0, 4.7] | 2.89 (large) | bad wins |
| LLM calls | **1.0** | 4.3 | +3.3 (+330%) | — | — | **bad WINS — 4.3× fewer** |
| total tokens | **3,600** | 33,140 | +29,540 (+820%) | [15659, 47426] | 2.57 (large) | **bad WINS — 9.2× fewer** |
| cost | **$0.013** | $0.046 | +$0.033 (+251%) | [$0.02, $0.05] | 2.77 (large) | **bad WINS — 3.5× cheaper** |
| cache-hit rate | 59% | 70% | — | — | — | browser-use higher |

### Aggregate summary

| | form-fill | extract | edit-export | what it tells us |
|---|---|---|---|---|
| **pass rate** | bad ✓ / browser-use ✓ | **bad ✗ / browser-use ✓** | bad ✓ / browser-use ✓ | bad's planner is unsafe for tasks where the final result depends on mid-run observations |
| **wall-time** | bad **5.9×** faster | bad 2.5× faster (wrong output) | bad **16.3×** faster | bad's planner+replan compresses N actions into ~1-3 LLM calls |
| **cost** | bad **2.4×** cheaper | n/a (wrong) | bad **3.5×** cheaper | bad makes 2-4× fewer LLM calls per task |
| **tokens** | bad **8.1×** fewer | n/a (wrong) | bad **9.2×** fewer | browser-use's per-step prompt is ~6-8K tokens; bad's planner amortizes the cost |
| **cache hit** | browser-use 81% vs bad 62% | browser-use 71% vs bad 58% | browser-use 70% vs bad 59% | browser-use's longer system prompt + per-step structure caches better — there's headroom for bad to improve |
| **variance** | bad 30-42s vs browser-use 169-239s | tight both | bad 8.9-9.9s vs browser-use 127-166s | bad is dramatically more consistent (planner makes runs deterministic) |

### What this tells us about each architecture

**bad's planner-then-execute (Gen 7 + Gen 7.1 replan loop):**
- **Strength:** compresses multi-step structured tasks (forms, product flows) into 1-3 LLM calls. Wall time becomes browser time, not LLM time. Variance is dramatically lower.
- **Weakness:** can't handle tasks where the final result must be computed from observations the planner can't see at planning time. The planner fabricates placeholder values it can't fill in later. Extraction tasks fail.

**browser-use 0.12.6's per-step react loop:**
- **Strength:** observe-then-act per turn means it always has fresh context. Extraction works because the agent reads the page values into the LLM context before generating the result.
- **Weakness:** every turn is an LLM call. Pays the per-turn LLM latency × N. Variance is high because each per-step LLM call can hit JSON-parse errors and retry (~3-7s spread per call). Hits its own JSON-output validation errors that drive retry loops on gpt-5.2.

### Honest caveats on this benchmark

- **n=3 reps per cell.** Mann-Whitney U p-values are ~0.081 across the board because that's the smallest p achievable with two 3-element samples — the test is power-limited at this sample size. Bootstrap CIs and Cohen's d are more informative here.
- **`text-in-snapshot` oracle false-positive risk for browser-use:** my Python bridge captures the final page DOM via a `on_step_end` callback (latest captured state). If the agent's last step doesn't trigger the callback after the relevant state change, the oracle reads stale state. For workflow tasks like dashboard-edit-export this means the oracle might pass on browser-use even if the actual final state didn't reach "Export complete for Alice Johnson" — the agent narrative typically mentions the expected text. A perfectly-fair oracle would inject a Playwright check at the very end; we're not there yet. Bad does NOT have this issue because its bad-adapter reads the actual ARIA snapshot from `events.jsonl observe-completed` events.
- **bad ran with `--config planner-on.mjs`.** Without the planner, bad falls back to the per-action loop and would look much more like browser-use on form-fill (slower, more LLM calls) but would PASS the extraction task. The architectural trade-off is real.
- **browser-use ran with `use_vision=False`.** Vision adds significant cost; turning it on would change the comparison axis to "vision vs no-vision" rather than "framework vs framework".
- **Same OpenAI account, same day.** Cross-framework comparisons MUST run under identical provider conditions or the comparison is between provider weather, not architectures.

## Honest known limitations

- **Single-machine, single-day**: cross-framework comparisons must run on the same machine the same day. LLM provider weather varies hour-to-hour.
- **Model parity**: every framework should be configured to the same model class (e.g. all on `gpt-5.2`), otherwise the comparison is "model A vs model B" not "framework A vs framework B".
- **Oracle tightness**: a `text-in-snapshot` oracle can be fooled by an agent that pastes the expected text into a textarea instead of submitting the form. Use the strictest oracle the task allows (`json-shape-match` for extraction tasks, `url-contains` for navigation tasks).
- **Cache-hit rates** are reported per cell but only when the underlying provider surfaces them. Anthropic does, OpenAI does, Google partially.
- **Bad's planner has a known failure mode on extraction tasks** (placeholder values in `complete.result` because the planner commits before observing). Tracked as a Gen 7.2 follow-up.
