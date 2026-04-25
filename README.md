# @tangle-network/browser-agent-driver

LLM-driven browser automation. Reads page state via accessibility tree, decides actions via LLM, executes in a loop until the goal is done.

90% pass rate on WebBench-50. Default model: `gpt-5.4`.

## Install

### CLI

```bash
curl -fsSL https://raw.githubusercontent.com/tangle-network/browser-agent-driver/main/scripts/install.sh | sh
```

Installs the `bad` command to `~/.local/bin`, downloads Playwright Chromium, and adds PATH instructions. Requires Node.js 20+.

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

### Programmatic

```typescript
import { chromium } from 'playwright'
import { PlaywrightDriver, BrowserAgent } from '@tangle-network/browser-agent-driver'

const browser = await chromium.launch()
const page = await browser.newPage()
const driver = new PlaywrightDriver(page)

const runner = new BrowserAgent({
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

## Design Audit

`bad design-audit` is a vision-powered product and design quality analyzer with a closed-loop improvement mode. It auto-classifies the page, runs ground-truth measurements (axe-core + WCAG contrast math), infers audience/job/stakes, then evaluates whether the page helps users complete the real product task — not just whether it looks clean. Findings are ranked by ROI.

```bash
# Audit any URL — auto-classifies, no profile needed
bad design-audit --url https://your-app.com

# Multi-page crawl with cross-page systemic detection
bad design-audit --url https://your-app.com --pages 10

# Serious review: parallel product, visual-system, and trust/workflow passes
bad design-audit --url https://your-app.com --audit-passes deep

# Closed-loop fix: dispatch findings to a coding agent that edits source files
bad design-audit --url http://localhost:3000 \
  --evolve claude-code \
  --project-dir ~/my-app

# Other evolve modes: codex, opencode, css (browser injection), or any custom CLI
bad design-audit --url http://localhost:3000 --evolve "aider --message"

# Pure DOM token extraction (no LLM)
bad design-audit --url https://your-app.com --extract-tokens
```

Reports open with **Top Fixes (by ROI)** — the 5 highest-leverage fixes ranked by `(impact × blast / effort)`. Findings appearing on multiple pages collapse into systemic findings. Verified end-to-end: a deliberately-bad fixture went 3.0 → 5.0 (+2.0) over 2 evolve rounds with claude-code rewriting actual source files.

See [Design Audit Guide](./docs/guides/design-audit.md) for the full pipeline, custom rubric fragments, and starter-foundry integration.

## Session Viewer

`bad view` opens any run in a polished web UI:

```bash
bad view audit-results/stripe.com-1775502457141
```

- Sidebar lists every page (or turn) in the run
- Top Fixes section opens by default for design audits, ranked by ROI
- Per-page screenshots, design system breakdown, findings table, classification
- Per-turn action JSON, reasoning, expected effect, result for agent runs
- Self-contained — no build pipeline, single static HTML, no external dependencies (the viewer is served by a local loopback HTTP server on port 7777)

Pair with `--show-cursor` to record runs with an animated cursor + element highlights overlaid on every screenshot.

## Drivers — local, remote, and managed

bad's agent loop is decoupled from the browser layer via the `Driver` interface. The default is local Playwright, but you can run the same agent against managed cloud infra without any code changes:

```typescript
import { BrowserAgent, SteelDriver } from '@tangle-network/browser-agent-driver'

// Local Playwright (default) — see Quick Start above

// Steel cloud browser with anti-bot, residential proxies, CAPTCHA solving
const driver = await SteelDriver.create({
  apiKey: process.env.STEEL_API_KEY,
  sessionOptions: { useProxy: true, solveCaptcha: true },
})
const agent = new BrowserAgent({ driver, config: { model: 'sonnet' } })
await agent.run({ goal: '...', startUrl: '...' })
await driver.close()
```

The same agent — design audit, evolve loops, wallet automation, knowledge memory — runs against any driver. Steel handles infra you don't want to build; bad handles the agent layer Steel doesn't.

## GitHub Action

Drop bad design-audit into any PR pipeline:

```yaml
- uses: tangle-network/browser-agent-driver/.github/actions/design-audit@main
  with:
    url: ${{ steps.deploy.outputs.preview_url }}
    pages: 5
    fail-on-score-below: '6.5'
    evolve: claude-code   # optional auto-fix
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

The action posts the **Top Fixes (by ROI)** as a PR comment, uploads the full report as a workflow artifact, and optionally fails the build on score regressions or critical findings. See [`.github/actions/design-audit`](./.github/actions/design-audit/).

## Guides

- [Configuration Reference](./docs/guides/configuration.md) — all config options
- [CLI Reference](./docs/guides/cli.md) — commands, modes, profiles, auth
- [Design Audit](./docs/guides/design-audit.md) — vision-powered design quality + ROI-ranked closed-loop improvement
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

Versioning and releases are automated via [Changesets](https://github.com/changesets/changesets).

**Contributors:** add a changeset to your PR with `pnpm changeset` — pick patch / minor / major and write a one-line summary. The CLI creates a markdown file under `.changeset/` to commit alongside your code.

**Maintainers:** when PRs with changesets merge to `main`, the [changesets workflow](./.github/workflows/changesets.yml) automatically opens (or updates) a "Release: version packages" PR that bumps `package.json` and writes `CHANGELOG.md`. Merging that PR pushes a `browser-agent-driver-vX.Y.Z` git tag, which fires the existing [`release.yml`](./.github/workflows/release.yml) and [`publish-npm.yml`](./.github/workflows/publish-npm.yml) workflows that create the GitHub release tarball and publish to npm with provenance.

You stay in control of *when* releases ship; the bump math, changelog, tagging, and publishing are all automated. See [`.changeset/README.md`](./.changeset/README.md) for the full contributor flow.

## Development

```bash
pnpm build          # TypeScript → dist/
pnpm test           # vitest
pnpm lint           # type-check
pnpm check:boundaries
```

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE).
