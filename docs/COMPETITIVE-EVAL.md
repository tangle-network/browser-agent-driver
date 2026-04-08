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

## What we'll learn

The first thing we want to know: **on the same form-fill task, how does `bad` compare to `browser-use` and `Stagehand`** on:

1. **Wall-time** — does our planner+replan architecture beat their per-action loops on a 19-field form?
2. **Cost per success** — when both finish, who's cheaper?
3. **Token efficiency** — how many input/output tokens per successful task?
4. **Cache utilization** — are we using prompt caching better than they are?
5. **Pass rate at the same model class** — comparable model, comparable prompt, who's more reliable?

Once we have answers per task, we'll know which architectural levers to pull next.

## Honest known limitations

- **Single-machine, single-day**: cross-framework comparisons must run on the same machine the same day. LLM provider weather varies hour-to-hour.
- **Model parity**: every framework should be configured to the same model class (e.g. all on `gpt-5.2`), otherwise the comparison is "model A vs model B" not "framework A vs framework B".
- **Oracle tightness**: a `text-in-snapshot` oracle can be fooled by an agent that pastes the expected text into a textarea instead of submitting the form. Use the strictest oracle the task allows (`json-shape-match` for extraction tasks, `url-contains` for navigation tasks).
- **Cache-hit rates** are reported per cell but only when the underlying provider surfaces them. Anthropic does, OpenAI does, Google partially.
