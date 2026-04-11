# @tangle-network/browser-agent-driver

General-purpose agentic browser automation. Completes real user outcomes on any website — search, extract, fill forms, compare prices, navigate complex UIs.

**91.3% on WebVoyager (590 tasks, 15 sites) at $0.09/task.** 100% on held-out competitive bench. 95.7% on WebbBench-50 (excl. DataDome sites). Default model: `gpt-5.4`.

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Features](#features)
  - [Vision + DOM Hybrid](#vision--dom-hybrid)
  - [Stealth & Anti-Bot](#stealth--anti-bot)
  - [CAPTCHA Solving](#captcha-solving)
  - [Parallel Tab Execution](#parallel-tab-execution)
  - [Multi-Model Orchestration](#multi-model-orchestration)
  - [Design Audit](#design-audit)
  - [Wallet & DeFi Testing](#wallet--defi-testing)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [SDK / Library Usage](#sdk--library-usage)
- [Test Suites](#test-suites)
- [Drivers](#drivers)
- [Benchmarks](#benchmarks)
- [GitHub Action](#github-action)
- [Development](#development)

## Install

### CLI (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/tangle-network/browser-agent-driver/main/scripts/install.sh | sh
```

Installs the `bad` command, downloads Chromium, adds PATH. Requires Node.js 20+.

Or via npm:

```bash
npm i -g @tangle-network/browser-agent-driver
npx playwright install chromium
```

### As a library

```bash
pnpm add @tangle-network/browser-agent-driver
pnpm add -D playwright
```

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

# Authenticated session
bad run --goal "Check account settings" --url https://app.example.com \
  --storage-state .auth/session.json

# With proxy (residential or SOCKS5)
bad run --goal "Search hotels in Tokyo" --url https://booking.com \
  --proxy http://user:pass@proxy.example.com:port
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
    model: 'gpt-5.4',
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

### Config File

Create `bad.config.ts` (or `.js`, `.mjs`) in your project root:

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  provider: 'openai',
  model: 'gpt-5.4',
  observationMode: 'hybrid',
  plannerEnabled: true,
  headless: true,
  concurrency: 4,
  maxTurns: 30,
  outputDir: './test-results',

  // Per-role model routing (Gen 28)
  models: {
    planner:    { model: 'claude-opus-4-6', provider: 'anthropic' },
    executor:   { model: 'gpt-4.1-mini' },
    verifier:   { model: 'gpt-4.1-mini' },
    supervisor: { model: 'gpt-5.4' },
  },

  // Parallel tabs for compound goals (Gen 21)
  parallelTabs: { enabled: true, maxTabs: 3 },

  // Proxy for anti-bot bypass
  proxy: 'http://user:pass@proxy:port',  // or set BAD_PROXY_URL env

  // Supervisor for stuck detection
  supervisor: { enabled: true, useVision: true },
})
```

Auto-detected by CLI and SDK. CLI flags override config values.

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

### Vision + DOM Hybrid

The agent sees BOTH a screenshot and the accessibility tree. Screenshots show visual layout, SoM labels mark interactive elements with numbered badges, and the a11y tree provides precise `@ref` IDs for targeting.

Three observation modes:
- **`dom`** — a11y tree only (fastest, cheapest)
- **`vision`** — screenshot + coordinates only
- **`hybrid`** — both (default for benchmarks, most reliable)

### Stealth & Anti-Bot

Built-in evasion for Cloudflare, Akamai, and most WAF systems:

- **System Chrome** (`channel: 'chrome'`) — real TLS/JA3/HTTP2 fingerprint, not bundled Chromium
- **Patchright** — Playwright fork that patches CDP protocol leaks
- **Mouse humanization** — Bezier curve movement (8-15 points), gaussian click offset
- **Browser fingerprint** — navigator.webdriver, plugins, languages, WebGL, canvas noise, screenX/Y fix
- **GPU rendering** — `--use-gl=desktop` for real WebGL fingerprint
- **Resource blocking** — 99+ analytics/tracking domains blocked

Unblocks 9/13 previously-blocked sites on WebbBench-50 with zero configuration.

### CAPTCHA Solving

Automatic CAPTCHA detection and solving during runs:

- **reCAPTCHA v2** — checkbox click + image grid solver (LLM vision-based)
- **Cloudflare Turnstile** — checkbox behavioral click
- **Google "unusual traffic"** — detected and solver attempted

```typescript
// Enabled by default. To configure:
{ captcha: { enabled: true, maxAttempts: 5 } }
```

### Parallel Tab Execution

For compound goals ("compare X vs Y", "find 5 items matching criteria"), the agent decomposes the goal and runs sub-tasks in parallel browser tabs.

```typescript
{
  parallelTabs: { enabled: true, maxTabs: 3 },
}
```

The GoalDecomposer (1 cheap LLM call) classifies goals as simple or compound. Simple goals run as before. Compound goals get split into sub-goals, each running in its own tab via `Promise.all`, with results merged by the EvidenceMerger.

### Multi-Model Orchestration

Different agent roles can use different models for optimal cost/quality:

```typescript
{
  models: {
    planner:    { model: 'claude-opus-4-6', provider: 'anthropic' },  // best reasoning
    executor:   { model: 'gpt-4.1-mini' },                            // cheap, follows plans
    verifier:   { model: 'gpt-4.1-mini' },                            // structured yes/no
    supervisor: { model: 'gpt-5.4' },                                 // strategic recovery
  },
}
```

Each role falls back to the main `model` when not configured. The planner needs top-tier reasoning; the executor just follows instructions.

### Design Audit

Vision-powered design quality analysis with closed-loop improvement:

```bash
# Audit any URL
bad design-audit --url https://your-app.com

# Multi-page crawl with cross-page systemic detection
bad design-audit --url https://your-app.com --pages 10

# Auto-fix: dispatch findings to a coding agent
bad design-audit --url http://localhost:3000 --evolve claude-code --project-dir ~/my-app
```

Reports rank **Top Fixes by ROI** — the highest-leverage changes scored by `(impact * blast / effort)`. Multi-page systemic findings collapse automatically.

### Wallet & DeFi Testing

Built-in MetaMask integration for DeFi app testing:

```bash
pnpm wallet:setup      # download MetaMask
pnpm wallet:onboard    # automate first-run wizard
pnpm wallet:anvil      # start Anvil mainnet fork (100 ETH + 10 WETH + 10k USDC)
pnpm wallet:validate   # run wallet test suite
```

Supports connect, swap, supply workflows across Uniswap, Aave, SushiSwap, 1inch.

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | string | `'openai'` | LLM provider |
| `model` | string | `'gpt-5.4'` | LLM model |
| `observationMode` | string | `'dom'` | `'dom'`, `'vision'`, or `'hybrid'` |
| `plannerEnabled` | boolean | `false` | Plan-then-execute mode |
| `headless` | boolean | `true` | Run browser headless |
| `maxTurns` | number | `30` | Max turns per task |
| `proxy` | string | — | Proxy URL (also `BAD_PROXY_URL` env) |
| `models` | object | — | Per-role model overrides |
| `parallelTabs` | object | — | `{ enabled, maxTabs }` |
| `supervisor` | object | — | `{ enabled, useVision, model }` |
| `captcha` | object | — | `{ enabled, maxAttempts }` |
| `goalVerification` | boolean | `true` | Verify goal before accepting |
| `vision` | boolean | `true` | Send screenshots to LLM |
| `concurrency` | number | `1` | Parallel test cases |

See [Configuration Reference](./docs/guides/configuration.md) for all options.

## CLI Reference

```bash
bad run [options]              # Run tasks
bad design-audit [options]     # Design quality analysis
bad view <run-dir>             # Open session viewer
bad competitive [options]      # Head-to-head framework comparison
```

### Run options

| Flag | Description |
|------|-------------|
| `--goal "..."` | Natural language goal |
| `--url URL` | Starting URL |
| `--cases file.json` | Test case file |
| `--mode fast-explore\|full-evidence` | Run mode |
| `--model MODEL` | LLM model |
| `--provider openai\|anthropic\|google` | LLM provider |
| `--observation-mode dom\|vision\|hybrid` | Observation mode |
| `--headless` | Run headless (default) |
| `--proxy URL` | Residential/SOCKS5/HTTP proxy |
| `--profile default\|stealth\|benchmark-webvoyager` | Launch profile |
| `--concurrency N` | Parallel cases |
| `--show-cursor` | Animated cursor overlay in screenshots |
| `--live` | Real-time SSE viewer |

## SDK / Library Usage

```typescript
import {
  // Core
  BrowserAgent,
  PlaywrightDriver,
  SteelDriver,
  TestRunner,

  // Config
  defineConfig,

  // Types
  type AgentConfig,
  type Scenario,
  type AgentResult,
  type Turn,

  // Multi-actor (parallel users)
  MultiActorSession,

  // Design audit
  runDesignAudit,

  // CAPTCHA
  detectCaptcha,
  solveCaptcha,
} from '@tangle-network/browser-agent-driver'
```

### Multi-Actor Sessions

```typescript
import { MultiActorSession } from '@tangle-network/browser-agent-driver'

const session = await MultiActorSession.create(browser, {
  actors: {
    admin:   { storageState: '.auth/admin.json' },
    user:    {},
  },
  agentConfig: { model: 'gpt-5.4', observationMode: 'hybrid' },
})

// Sequential
await session.actor('admin').run({ goal: 'Create project', startUrl: '/admin' })

// Parallel
await session.parallel(
  ['admin', { goal: 'Monitor dashboard', startUrl: '/admin' }],
  ['user',  { goal: 'Submit form', startUrl: '/app' }],
)

await session.close()
```

## Test Suites

```typescript
import { TestRunner } from '@tangle-network/browser-agent-driver'

const runner = new TestRunner({
  driver,
  config: { model: 'gpt-5.4', observationMode: 'hybrid' },
  concurrency: 4,
})

const results = await runner.runSuite([
  {
    id: 'login',
    goal: 'Log in with test@example.com / password123',
    startUrl: 'https://app.example.com/login',
  },
  {
    id: 'create-project',
    goal: 'Create a new project called "Test Project"',
    startUrl: 'https://app.example.com/projects',
  },
])
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

## Benchmarks

| Benchmark | Score | Cost | Notes |
|-----------|-------|------|-------|
| **WebVoyager** (590 tasks, 15 sites) | 91.3% | $0.09/task | Full run, Gen 25 |
| **Competitive** (10 real-web sites) | 100% | $0.03/task | Held-out, never optimized |
| **WebbBench-50** (50 diverse sites) | 88% raw, 95.7% excl. DataDome | — | Held-out generalization |

### Competitive position

| Agent | WebVoyager | Cost/task |
|-------|-----------|-----------|
| Surfer-2 | 97.1% | $1-5 |
| Magnitude | 93.9% | ~$0.10 |
| **bad** | **91.3%** | **$0.09** |
| OpenAI Operator | 87% | ChatGPT Pro |

### Running benchmarks

```bash
# WebVoyager full 590
node scripts/run-scenario-track.mjs \
  --cases bench/external/webvoyager/cases.json \
  --config bench/scenarios/configs/vision-hybrid.mjs \
  --model gpt-5.4 --modes fast-explore --concurrency 5 \
  --out agent-results/webvoyager-full

# Multi-rep validation (≥3 reps required for any claim)
node scripts/run-multi-rep.mjs \
  --cases bench/scenarios/cases/my-cases.json \
  --config bench/scenarios/configs/vision-hybrid.mjs \
  --reps 3 --out agent-results/my-validation
```

## GitHub Action

```yaml
- uses: tangle-network/browser-agent-driver/.github/actions/design-audit@main
  with:
    url: ${{ steps.deploy.outputs.preview_url }}
    pages: 5
    fail-on-score-below: '6.5'
    evolve: claude-code
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

Posts Top Fixes as a PR comment, uploads full report as artifact, optionally fails on score regressions.

## Session Viewer

```bash
bad view audit-results/stripe.com-1775502457141
```

Web UI with per-turn screenshots, action JSON, reasoning, element highlights. Pair with `--show-cursor` for animated cursor recordings.

## Guides

- [Configuration Reference](./docs/guides/configuration.md)
- [CLI Reference](./docs/guides/cli.md)
- [Design Audit](./docs/guides/design-audit.md)
- [Memory System](./docs/guides/memory.md)
- [Benchmarks & Experiments](./docs/guides/benchmarks.md)
- [Wallet & EVM Apps](./docs/guides/wallet.md)
- [Providers](./docs/guides/providers.md)
- [Custom Drivers](./docs/guides/custom-drivers.md)

## Development

```bash
pnpm build              # TypeScript → dist/
pnpm test               # 993 tests
pnpm lint               # type-check
pnpm check:boundaries   # architecture boundaries
```

## Publishing

Automated via [Changesets](https://github.com/changesets/changesets) + OIDC trusted publishing. Add a changeset with `pnpm changeset`, merge the auto-generated release PR, and npm publish fires automatically with provenance attestation.

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE).
