# @tangle-network/browser-agent-driver

General-purpose agentic browser automation. Completes real user outcomes on any website — search, extract, fill forms, compare prices, navigate complex UIs.

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Features](#features)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [SDK / Library Usage](#sdk--library-usage)
- [Examples](#examples)
- [Benchmarks](#benchmarks)
- [Drivers](#drivers)
- [GitHub Action](#github-action)
- [Session Viewer](#session-viewer)
- [Agent Discovery](#agent-discovery)
- [Development](#development)
- [License](#license)

## Install

```bash
# CLI installer — installs the `bad` command, downloads Chromium, adds PATH (Node.js 20+)
curl -fsSL https://raw.githubusercontent.com/tangle-network/browser-agent-driver/main/scripts/install.sh | sh

# or via npm
npm install -g @tangle-network/browser-agent-driver
npx playwright install chromium

# as a library
pnpm add @tangle-network/browser-agent-driver
pnpm add -D playwright
```

Do not install the unscoped `bad` package from npm. It is unrelated to Tangle. The `bad` command is installed by `@tangle-network/browser-agent-driver`.

## Quick Start

### CLI

```bash
# Run a task
bad run --goal "Find the cheapest flight from NYC to London on Jan 15" \
  --url https://www.google.com/travel/flights

# With vision (screenshot-based decisions)
bad run --goal "Compare MacBook Air prices" --url https://apple.com \
  --observation-mode hybrid

# Test suite from case file
bad run --cases ./my-tests.json --concurrency 4
```

### SDK

```typescript
import { chromium } from 'playwright'
import { PlaywrightDriver, BrowserAgent } from '@tangle-network/browser-agent-driver'

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage()
const driver = new PlaywrightDriver(page)

const agent = new BrowserAgent({
  driver,
  config: {
    model: 'gemini-2.5-flash',
    provider: 'google',
    observationMode: 'hybrid',    // vision + DOM
    plannerEnabled: true,          // plan-then-execute
  },
})

const result = await agent.run({
  goal: 'Find the top 3 trending repositories on GitHub',
  startUrl: 'https://github.com/trending',
})

console.log(result.success, result.reason)
await browser.close()
```

## How It Works

```
Goal → DOM Planner (1 LLM call with screenshot)
  → N deterministic steps (click, type, fill, navigate)
  → If deviation: vision per-action loop
    → Observe (a11y tree + screenshot + SoM labels)
    → LLM decides action (ref-based, coordinate, or label)
    → Execute + verify expected effect
    → Recovery on failure (strategy shift, form reset retry, search fallback)
  → Goal verification (LLM or fast-path with script evidence)
  → Complete with structured result
```

Recovery is automatic: cookie consent, modal blockers, A-B-A-B oscillation loops, form field resets, date picker stalls, and CAPTCHA challenges are handled before the agent continues.

## Features

- **Vision + DOM Hybrid** — the agent sees both a screenshot (SoM-labeled interactive elements) and the a11y tree (precise `@ref` IDs). Observation modes: `dom` (fastest), `vision`, `hybrid` (most reliable).
- **Stealth & Anti-Bot** — system Chrome (`channel: 'chrome'`, real TLS/JA3 fingerprint), Patchright (CDP leak patches), Bezier mouse humanization, fingerprint hardening (webdriver, WebGL, canvas noise, screenX/Y), 99+ analytics domains blocked. Unblocks most Cloudflare/Akamai WAF setups with zero configuration.
- **CAPTCHA Solving** — reCAPTCHA v2 (checkbox + vision-based grid solver), Cloudflare Turnstile, Google "unusual traffic". On by default: `{ captcha: { enabled: true, maxAttempts: 5 } }`.
- **Parallel Tab Execution** — compound goals ("compare X vs Y") are split by the GoalDecomposer (1 cheap LLM call) into sub-goals running in parallel tabs, merged by the EvidenceMerger: `{ parallelTabs: { enabled: true, maxTabs: 3 } }`.
- **Multi-Model Orchestration** — per-role model routing (`planner` / `executor` / `verifier` / `supervisor`) across `openai`, `anthropic`, `google`, `claude-code`, `codex-cli`, `zai-coding-plan`, `cli-bridge`, `sandbox-backend`. Roles fall back to the main `model` when not configured.

### Design Audit

Vision-powered design quality analysis with closed-loop improvement:

```bash
bad design-audit --url https://your-app.com                  # audit any URL
bad design-audit --url https://your-app.com --pages 10       # multi-page crawl, systemic detection
bad design-audit --url http://localhost:3000 --evolve claude-code --project-dir ~/my-app  # auto-fix
```

Reports rank **Top Fixes by ROI** — the highest-leverage changes scored by `(impact * blast / effort)`.

### Wallet & DeFi Testing (specialized niche)

A built-in MetaMask workflow for teams testing DeFi apps — a deliberate specialization, not the general-purpose path:

```bash
pnpm wallet:setup      # download MetaMask
pnpm wallet:onboard    # automate first-run wizard
pnpm wallet:anvil      # start Anvil mainnet fork (100 ETH + 10 WETH + 10k USDC)
pnpm wallet:validate   # run wallet test suite
```

Supports connect, swap, supply workflows across Uniswap, Aave, SushiSwap, 1inch. See [the wallet guide](./docs/guides/wallet.md).

## Configuration

Create `bad.config.ts` (or `.js`, `.mjs`) in your project root:

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  model: 'gemini-2.5-flash',
  provider: 'google',
  observationMode: 'hybrid',
  plannerEnabled: true,
  headless: true,
  concurrency: 4,
  maxTurns: 30,
  outputDir: './test-results',
})
```

Auto-detected by CLI and SDK. CLI flags override config values.

The **default provider is credential-aware**: with no explicit `provider`, `bad` uses OpenAI when `OPENAI_API_KEY` is set and otherwise falls back to the keyless `claude-code` provider. The bench-validated default model is `gemini-2.5-flash` (Google) — see [Benchmarks](#benchmarks). Key options:

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | credential-aware | `openai` if `OPENAI_API_KEY` set, else `claude-code` |
| `model` | per-provider | LLM model (`gemini-2.5-flash` is the bench-validated choice) |
| `observationMode` | `'dom'` | `'dom'`, `'vision'`, or `'hybrid'` |
| `plannerEnabled` | `false` | Plan-then-execute mode |
| `maxTurns` | `30` | Max turns per task |
| `proxy` | — | Proxy URL (also `BAD_PROXY_URL` env) |
| `models` | — | Per-role model overrides |

See [Configuration Reference](./docs/guides/configuration.md) for all options.

## CLI Reference

```bash
bad run [options]              # Run tasks
bad snapshot --url <url>       # Headless accessibility-tree dump (no LLM)
bad design-audit [options]     # Design quality analysis
bad view <run-dir>             # Open session viewer
bad competitive [options]      # Head-to-head framework comparison
```

Full flag reference (run modes, execution profiles, auth sessions, adaptive model routing): [docs/guides/cli.md](./docs/guides/cli.md).

## SDK / Library Usage

```typescript
import {
  BrowserAgent,
  PlaywrightDriver,
  SteelDriver,
  TestRunner,
  MultiActorSession,
  defineConfig,
  DesignAuditor,
  detectCaptcha,
  solveCaptcha,
  type AgentConfig,
  type Scenario,
  type AgentResult,
} from '@tangle-network/browser-agent-driver'
```

## Examples

Runnable recipes live in [`examples/`](./examples/README.md): SDK quickstart, authoring a bench task, replay-cache CI, the GitHub Action, and shareable run videos.

## Benchmarks

Current bench (2026-10-11, gemini-2.5-flash, headless, external oracle, 5-task competitive corpus × 3 reps + n=5 variance arm): **15/15 main + 10/10 arm, $0.0223/run, 17.9s wall, 30% replay-cache hit rate.** browser-use on the same corpus: 12/15 @ $0.0126/run. Cost ratio 1.8×, accepted asymptote 1.3–1.6× (1.0× would sacrifice extraction accuracy and the replay moat). Replay-cache reruns cost ~10–20% of a live run with zero decide calls. Full methodology: [docs/bench-2026-10-11-hillclimb-program.md](./docs/bench-2026-10-11-hillclimb-program.md); competitive evaluation: [docs/COMPETITIVE-EVAL.md](./docs/COMPETITIVE-EVAL.md).

Run it:

```bash
pnpm bench:compete
```

## Drivers

The agent loop is decoupled from the browser via the `Driver` interface:

```typescript
// Local Playwright (default)
const driver = new PlaywrightDriver(page)

// Steel cloud browser (anti-bot, residential proxies, CAPTCHA)
const driver = await SteelDriver.create({
  apiKey: process.env.STEEL_API_KEY,
  sessionOptions: { useProxy: true, solveCaptcha: true },
})

// Any Driver implementation works
const agent = new BrowserAgent({ driver, config })
```

## GitHub Action

```yaml
- uses: tangle-network/browser-agent-driver/.github/actions/design-audit@main
  with:
    url: ${{ steps.deploy.outputs.preview_url }}
    pages: 5
    fail-on-score-below: '6.5'
    evolve: claude-code
```

Posts Top Fixes as a PR comment, uploads the full report as an artifact, optionally fails on score regressions.

## Session Viewer

```bash
bad view audit-results/stripe.com-1775502457141
```

Web UI with per-turn screenshots, action JSON, reasoning, element highlights. A run's `report.json` is also a complete trace that renders into a shareable video via [`run-capsule`](https://github.com/tangle-network/run-capsule) — see [examples/run-capsule.md](./examples/run-capsule.md).

## Agent Discovery

Agents integrating Browser Agent should start from the live manifest at https://browser.tangle.tools/llms.txt. The same discovery manifest (`llms.txt` + `tangle-agent.json`) ships in the npm package under `discovery/`.

## Development

Use the canonical [admitted local signoff](./docs/SIGNOFF.md) for frozen installation, type-checked build, architecture/release-plan checks and browser-enabled integration qualification. It runs against the exact committed revision; paid benchmarks remain separately authorized experiments.

Publishing is automated via [Changesets](https://github.com/changesets/changesets) + OIDC trusted publishing: add a changeset with `pnpm changeset`, merge the release PR, npm publish fires with provenance attestation.

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE).
