# @tangle-network/browser-agent-driver

LLM-driven browser automation. Reads page state via accessibility tree, decides actions via LLM, executes in a loop until the goal is done.

90% pass rate on WebBench-50. Default model: `gpt-5.4`.

## Install

```bash
pnpm add @tangle-network/browser-agent-driver
pnpm add -D playwright
```

## Quick Start

### Programmatic

```typescript
import { chromium } from 'playwright'
import { PlaywrightDriver, AgentRunner } from '@tangle-network/browser-agent-driver'

const browser = await chromium.launch()
const page = await browser.newPage()
const driver = new PlaywrightDriver(page)

const runner = new AgentRunner({
  driver,
  config: { model: 'gpt-5.4' },
})

const result = await runner.run({
  goal: 'Sign in and navigate to settings',
  startUrl: 'https://app.example.com',
  maxTurns: 30,
})

console.log(result.success, `${result.turns.length} turns`)
await browser.close()
```

### CLI

```bash
# single task
bad run --goal "Sign up for account" --url http://localhost:3000

# test suite from case file
bad run --cases ./cases.json

# authenticated session
bad run --goal "Open settings" --url https://app.example.com \
  --storage-state ./.auth/session.json

# speed-optimized mode
bad run --cases ./cases.json --mode fast-explore

# evidence-rich mode for signoff
bad run --cases ./cases.json --mode full-evidence
```

## Config File

Create `browser-agent-driver.config.ts` in your project root:

```typescript
import { defineConfig } from '@tangle-network/browser-agent-driver'

export default defineConfig({
  model: 'gpt-5.4',
  headless: true,
  concurrency: 4,
  maxTurns: 30,
  timeoutMs: 300_000,
  outputDir: './test-results',
  reporters: ['junit', 'html'],
})
```

Auto-detected by CLI and programmatic API. CLI flags override config values. Supports `.ts`, `.js`, `.mjs`.

## Test Suites

```typescript
import { TestRunner } from '@tangle-network/browser-agent-driver'

const suite = await runner.runSuite([
  {
    id: 'login',
    name: 'User login flow',
    startUrl: 'https://app.example.com/login',
    goal: 'Log in with test credentials',
    successCriteria: [
      { type: 'url-contains', value: '/dashboard' },
      { type: 'element-visible', selector: '[data-testid="user-menu"]' },
    ],
  },
])
```

## Actions

The LLM can perform: `click`, `type`, `press`, `hover`, `select`, `scroll`, `navigate`, `wait`, `evaluate`, `verifyPreview`, `complete`, `abort`.

## How It Works

Each turn: observe page (a11y tree + optional screenshot) → LLM decides action → execute → verify effect → repeat.

Recovery is automatic: cookie consent, modal blockers, stuck loops (A-B-A-B oscillation), and selector failures are handled before the agent continues.

## Guides

- [Configuration Reference](./docs/guides/configuration.md) — all config options
- [CLI Reference](./docs/guides/cli.md) — commands, modes, profiles, auth
- [Memory System](./docs/guides/memory.md) — trajectory store, app knowledge, selector cache
- [Benchmarks & Experiments](./docs/guides/benchmarks.md) — tiered gates, AB specs, research cycles
- [Wallet & EVM Apps](./docs/guides/wallet.md) — MetaMask, DeFi testing, RPC interception, Anvil forks
- [Providers](./docs/guides/providers.md) — OpenAI, Anthropic, Codex CLI, Claude Code, sandbox backend
- [Reporters & Sinks](./docs/guides/reporters.md) — JUnit, HTML, webhooks, custom sinks
- [Custom Drivers](./docs/guides/custom-drivers.md) — implement the `Driver` interface

## Research

- [Operating Roadmap](./docs/roadmap/browser-agent-ops.md)
- [Competitive Analysis](./docs/research/competitor-analysis-2026-03.md)
- [Reliability Runbook](./RELIABILITY.md)

## Skills

Ships Codex skills under `skills/` for test execution discipline and agent-friendly UX conventions.

```bash
npm run skills:install
```

## Publishing

Tag-triggered via `.github/workflows/publish-npm.yml`. Push `browser-agent-driver-vX.Y.Z` to publish.

## Development

```bash
pnpm build          # TypeScript → dist/
pnpm test           # vitest
pnpm lint           # type-check
pnpm check:boundaries
```

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE).
