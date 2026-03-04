# @tangle-network/agent-browser-driver

LLM-driven browser automation agent. Observe page state via accessibility tree, decide actions via LLM, execute in a loop until the goal is achieved.

## Features

- **Stable @ref selectors** — deterministic FNV-1a hashes of role+name, so the same element keeps the same ref across observations
- **Multimodal vision** — screenshots + a11y tree sent to the LLM for layout-aware decisions
- **Post-action verification** — checks expected effects after each action
- **Stuck detection + recovery** — auto-detects loops and triggers recovery strategies
- **Adaptive blocker recovery** — detects dialogs (quota/limit/modals), performs deterministic unblock actions, then resumes the goal
- **Conversation history** — LLM remembers previous turns for multi-step reasoning
- **Trajectory memory** — stores successful runs for case-based reasoning on future tasks
- **Test runner** — dependency-aware suite orchestration with ground-truth verification
- **Config file** — `agent-browser-driver.config.ts` with `defineConfig()` for IDE autocomplete
- **JUnit XML reporter** — native CI integration (GitHub Actions, Jenkins, GitLab)
- **Webhook sink** — push results to Slack, Discord, or custom dashboards
- **Design auditing** — systematic UI/UX flow auditing with structured findings
- **Preview verification** — navigates into preview iframes to check for errors

## Installation

```bash
npm install @tangle-network/agent-browser-driver
# or
pnpm add @tangle-network/agent-browser-driver
npm install -D playwright  # peer dependency
```

Package: https://www.npmjs.com/package/@tangle-network/agent-browser-driver

## Skills Pack

This repository ships versioned Codex skills under `skills/` for:
- test execution discipline (`agent-browser-driver-testing`)
- agent-friendly product UX conventions (`agent-friendly-app-design`)

Install locally:

```bash
npm run skills:install
```

Custom destination:

```bash
npm run skills:install -- --out /absolute/path/to/skills
```

## Publishing

Automated npm publishing is configured in:
- `.github/workflows/publish-npm.yml`

Triggers:
- Push tag `agent-browser-driver-vX.Y.Z`
- Manual `workflow_dispatch` with `version` input

Release flow:
1. Bump `package.json` version.
2. Merge to `main`.
3. Push tag `agent-browser-driver-v<same-version>`.
4. Workflow runs build/tests and publishes to npm (`npm publish --provenance --access public`).

### One-time npm Trusted Publishing (OIDC) setup

In npm package settings for `@tangle-network/agent-browser-driver`:
1. Add trusted publisher.
2. Provider: GitHub Actions.
3. Owner: `tangle-network`.
4. Repository: `agent-browser-driver`.
5. Workflow file: `publish-npm.yml`.

After this is configured, no long-lived npm token is required.

## Quick Start

```typescript
import { chromium } from 'playwright';
import { PlaywrightDriver, AgentRunner } from '@tangle-network/agent-browser-driver';

const browser = await chromium.launch();
const page = await browser.newPage();

const driver = new PlaywrightDriver(page, {
  captureScreenshots: true,
});

const runner = new AgentRunner({
  driver,
  config: {
    model: 'gpt-5.2',
    debug: true,
    maxHistoryTurns: 15,
    retries: 3,
  },
  onTurn: (turn) => {
    console.log(`Turn ${turn.turn}: ${turn.action.action}`);
    if (turn.reasoning) console.log(`  Reasoning: ${turn.reasoning}`);
  },
});

const result = await runner.run({
  goal: 'Sign in and navigate to settings',
  startUrl: 'https://app.example.com',
  maxTurns: 50,
});

console.log(result.success ? 'Success' : `Failed: ${result.reason}`);
console.log(`Completed in ${result.turns.length} turns, ${result.totalMs}ms`);

await browser.close();
```

## Config File

Create `agent-browser-driver.config.ts` in your project root:

```typescript
import { defineConfig } from '@tangle-network/agent-browser-driver';

export default defineConfig({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  headless: true,
  concurrency: 4,
  maxTurns: 30,
  timeoutMs: 300_000,
  outputDir: './test-results',
  reporters: ['junit', 'html'],
  memory: { enabled: true },
});
```

The CLI and programmatic API both auto-detect this file. CLI flags override config values. Supports `.ts`, `.js`, `.mjs`.

### DriverConfig

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `'openai' \| 'anthropic' \| 'google'` | `'openai'` | LLM provider |
| `model` | `string` | `'gpt-5.2'` | Model name |
| `adaptiveModelRouting` | `boolean` | `false` | Route early navigation turns to `navModel` |
| `navModel` | `string` | — | Fast model used when adaptive routing is enabled |
| `navProvider` | `'openai' \| 'anthropic' \| 'google'` | same as `provider` | Provider for `navModel` |
| `apiKey` | `string` | env var | API key |
| `baseUrl` | `string` | — | Custom endpoint (LiteLLM, etc.) |
| `browser` | `'chromium' \| 'firefox' \| 'webkit'` | `'chromium'` | Browser engine for execution |
| `headless` | `boolean` | `true` | Browser headless mode |
| `viewport` | `{ width, height }` | `1920x1080` | Browser viewport |
| `browserArgs` | `string[]` | `[]` | Extra Chromium launch args |
| `wallet` | `{ enabled?, extensionPaths?, userDataDir?, autoApprove?, password?, preflight? }` | — | Extension mode for wallet/crypto flows (Chromium persistent context) with optional prompt auto-approval and preflight |
| `storageState` | `string` | — | Playwright storage state JSON path (pre-authenticated session) |
| `maxTurns` | `number` | `30` | Max turns per test |
| `timeoutMs` | `number` | `600000` | Per-test timeout |
| `concurrency` | `number` | `1` | Parallel workers |
| `screenshotInterval` | `number` | `5` | Capture every N turns |
| `vision` | `boolean` | `true` | Send screenshots to LLM |
| `goalVerification` | `boolean` | `true` | Verify goal completion |
| `qualityThreshold` | `number` | `0` | Min quality 1-10 (0=skip) |
| `outputDir` | `string` | `'./agent-results'` | Artifact output dir |
| `reporters` | `('json' \| 'markdown' \| 'html' \| 'junit')[]` | `['json']` | Report formats |
| `sinks` | `ArtifactSink[]` | — | Custom artifact sinks |
| `resourceBlocking` | `ResourceBlockingOptions` | — | Block analytics/images/media for faster tests |
| `memory` | `{ enabled, dir, traceScoring, traceTtlDays }` | `disabled` | Trajectory memory + scored trace selection |
| `projects` | `Array<{ name, config, testDir, testMatch }>` | — | Named project configs |

### Built-in Personas

- `alice-blueprint-builder`: persona directive for realistic product flows with:
- adaptive blocker handling
- settings/model/provider discovery heuristics
- partner route hints (`/partner/coinbase`, `/partner/succinct`, `/partner/tangle`)
- substantive completion criteria (usable output, not toy chat turns)
- `auto`: derives an adaptive persona directive from your `goal` + `url` (recommended for out-of-box usage)

## Wallet Automation (Extensions)

For wallet flows (MetaMask, Rabby, etc.), use persistent Chromium context mode.

```typescript
import { defineConfig } from '@tangle-network/agent-browser-driver';

export default defineConfig({
  headless: false,
  concurrency: 1,
  wallet: {
    enabled: true,
    extensionPaths: ['./extensions/metamask'],
    userDataDir: './.agent-wallet-profile',
    autoApprove: true,
    password: process.env.AGENT_WALLET_PASSWORD,
    preflight: {
      enabled: true,
      chain: {
        id: 31337,
        rpcUrl: 'http://127.0.0.1:8545',
      },
    },
  },
});
```

CLI equivalent:

```bash
agent-driver run \
  --cases ./wallet-cases.json \
  --wallet \
  --extension ./extensions/metamask \
  --user-data-dir ./.agent-wallet-profile \
  --wallet-auto-approve \
  --wallet-password "$AGENT_WALLET_PASSWORD" \
  --wallet-preflight \
  --wallet-chain-id 31337 \
  --wallet-chain-rpc-url http://127.0.0.1:8545 \
  --no-headless
```

Notes:
- Wallet mode is activated only by `wallet.enabled` or `wallet.extensionPaths`.
- `wallet.userDataDir` only configures profile path once wallet mode is active.
- Wallet mode uses `chromium.launchPersistentContext(...)`.
- `--storage-state` is applied in wallet mode and non-wallet mode.
- Concurrency is forced to `1` in wallet mode.
- Headless is forced off in wallet mode.
- Auto-approval can unlock and approve wallet extension prompts across popup/notification/home pages.
- Preflight can authorize accounts + switch/add chain before test turns begin.
- Use a dedicated automation profile dir, not your everyday Chrome profile.

## Actions

The LLM can choose from:

| Action | Description |
|--------|-------------|
| `click` | Click element by @ref selector |
| `type` | Type text into input |
| `press` | Press a key (Enter, Tab, Escape, etc.) |
| `hover` | Hover over element |
| `select` | Select dropdown option |
| `scroll` | Scroll up/down |
| `navigate` | Go to URL |
| `wait` | Wait for ms |
| `evaluate` | Assess visual quality |
| `verifyPreview` | Check preview iframe for errors |
| `complete` | Goal achieved |
| `abort` | Cannot continue |

## Recovery Strategy Notes

The runner applies deterministic recovery before each turn:

- **Blocker-first**: if a modal/dialog is detected, it is resolved before normal goal actions continue.
- **Quota/limit dialogs**: recovery prefers management paths first (`Manage projects`, `Billing`, etc.), then cleanup actions (`Delete/Remove/Archive`) if required.
- **Fallback dismissal**: if no actionable button is found, `Escape` is used to close overlays.
- **Stuck/selector failures**: existing stuck and selector-failure strategies still apply after blocker recovery.

## Test Runner

Run structured test suites with ground-truth verification:

```typescript
import { TestRunner } from '@tangle-network/agent-browser-driver';

const runner = new TestRunner({
  driver,
  config: { model: 'gpt-5.2', vision: true },
  enableMemory: true,
});

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
]);

console.log(`Pass rate: ${(suite.summary.passRate * 100).toFixed(0)}%`);
```

## CLI

```bash
# Single task
agent-driver run --goal "Sign up for account" --url http://localhost:3000

# Test suite with config file
agent-driver run --cases ./cases.json

# Override config with CLI flags
agent-driver run --cases ./cases.json --model claude-sonnet-4-20250514 --concurrency 4 --browser firefox

# Run with an already-authenticated browser session
agent-driver run --goal "Open settings" --url https://ai.tangle.tools --storage-state ./.auth/ai-tangle-tools.json

# Explicit config path
agent-driver run --config ./ci.config.ts --cases ./cases.json

# Wallet mode with extension
agent-driver run --cases ./wallet-cases.json --wallet --extension ./extensions/metamask --no-headless
```

### Authenticated Session Reuse

Save a logged-in browser state once:

```bash
pnpm auth:save-state https://ai.tangle.tools ./.auth/ai-tangle-tools.json
```

Then reuse it in runs:

```bash
agent-driver run --goal "Create a project and verify preview" \
  --url https://ai.tangle.tools \
  --storage-state ./.auth/ai-tangle-tools.json

# Persona-driven flow
agent-driver run \
  --goal "Create a Coinbase blueprint project and verify usable output" \
  --url https://ai.tangle.tools \
  --storage-state ./.auth/ai-tangle-tools.json \
  --persona alice-blueprint-builder

# Auto persona flow (no manual persona writing)
agent-driver run \
  --goal "Build a partner template app and verify preview works" \
  --url https://ai.tangle.tools \
  --storage-state ./.auth/ai-tangle-tools.json \
  --persona auto

# Mode presets
agent-driver run --goal "Map key routes fast" --url https://ai.tangle.tools --mode fast-explore
agent-driver run --goal "Run signoff flow with rich evidence" --url https://ai.tangle.tools --mode full-evidence
```

### Run Modes

- `fast-explore`: optimized for speed. Defaults to `--no-vision`, `--screenshot-interval 0`, analytics blocking on, goal verification on.
- `full-evidence`: optimized for release/signoff evidence. Defaults to `--vision`, `--screenshot-interval 3`, goal verification on.
- Mode presets only apply defaults; explicit CLI flags still take precedence.

### Adaptive Model Routing (Feature Flag)

Use a faster model for early navigation turns, while keeping your primary model for blocker/verification-heavy turns:

```bash
agent-driver run \
  --goal "Complete flow" \
  --url https://ai.tangle.tools \
  --model gpt-5.2 \
  --model-adaptive \
  --nav-model gpt-4.1-mini
```

- `--model-adaptive`: enable routing for `decide()` turns.
- `--nav-model`: model used for early non-blocker navigation turns.
- `--nav-provider`: optional provider override for nav model.

### Trace Scoring (Feature Flag)

Enable scored trajectory reuse (requires memory mode):

```bash
agent-driver run \
  --goal "Complete flow" \
  --url https://ai.tangle.tools \
  --memory \
  --memory-dir ./.agent-memory \
  --trace-scoring \
  --trace-ttl-days 30
```

### Baseline Mode Comparison

Run the same goal in both modes and emit a comparison summary:

```bash
npm run baseline:modes -- \
  --goal "Navigate to /partner/coinbase and verify Coinbase templates are visible" \
  --url https://ai.tangle.tools \
  --storage-state ./.auth/ai-tangle-tools.json \
  --model gpt-5.2 \
  --max-turns 35
```

Outputs `baseline-summary.json` under `./agent-results/mode-baseline-<timestamp>/`.

### Scenario Track Baseline

Run multi-scenario mode comparisons from a case track file:

```bash
npm run baseline:track -- \
  --cases ./bench/scenarios/cases/staging-auth-ai-tangle.json \
  --storage-state ./.auth/ai-tangle-tools.json \
  --model gpt-5.2
```

Outputs `track-summary.json` under `./agent-results/track-<timestamp>/`.

## Reporters

### JUnit XML (CI integration)

```typescript
import { generateReport } from '@tangle-network/agent-browser-driver';

const xml = generateReport(suiteResult, { format: 'junit' });
fs.writeFileSync('results.xml', xml);
```

Or use it directly:

```typescript
import { generateJUnitXml } from '@tangle-network/agent-browser-driver';

const xml = generateJUnitXml(suiteResult);
```

Produces standard JUnit XML that GitHub Actions, Jenkins, and GitLab parse natively. Tests grouped by `testCase.category`, failures include verdict + last actions.

### Other formats

```typescript
generateReport(suite, { format: 'json' });      // Full TestSuiteResult JSON
generateReport(suite, { format: 'markdown' });   // Summary + per-test table
generateReport(suite, { format: 'html' });       // Styled dashboard
```

## Artifact Sinks

### FilesystemSink (built-in)

```typescript
import { FilesystemSink } from '@tangle-network/agent-browser-driver';

const sink = new FilesystemSink('./results');
// Writes: results/{testId}/turn-05.jpg, results/manifest.json
```

### WebhookSink

POST artifact events to any URL (Slack, Discord, CI dashboard):

```typescript
import { WebhookSink } from '@tangle-network/agent-browser-driver';

const sink = new WebhookSink({
  url: 'https://hooks.slack.com/services/...',
  headers: { Authorization: 'Bearer token' },
  events: ['screenshot', 'report-json'],  // filter artifact types
  includeData: false,                      // skip base64 payload
  retries: 3,                              // exponential backoff
});
```

On `put()`, POSTs:
```json
{ "event": "artifact", "testId": "signup", "type": "screenshot", "name": "turn-05.jpg", "sizeBytes": 45230 }
```

On `close()`, POSTs:
```json
{ "event": "suite:complete", "manifest": [...], "summary": { "total": 5, "passed": 4, "failed": 1 } }
```

Never throws — webhook failures are logged, not fatal.

### CompositeSink

Chain multiple sinks (write locally + POST to webhook):

```typescript
import { CompositeSink, FilesystemSink, WebhookSink } from '@tangle-network/agent-browser-driver';

const sink = new CompositeSink([
  new FilesystemSink('./results'),  // primary — URIs come from this one
  new WebhookSink({ url: '...' }), // secondary
]);
```

## Custom Drivers

Implement the `Driver` interface:

```typescript
import type { Driver, ActionResult } from '@tangle-network/agent-browser-driver';

class MyDriver implements Driver {
  async observe(): Promise<PageState> { /* ... */ }
  async execute(action: Action): Promise<ActionResult> { /* ... */ }
  getPage?(): Page | undefined { /* ... */ }
  async screenshot?(): Promise<Buffer> { /* ... */ }
  async close?(): Promise<void> { /* ... */ }
}
```

## Development

```bash
pnpm build       # TypeScript → dist/
pnpm test        # vitest (49 unit tests, ~130ms)
pnpm test:watch  # vitest watch mode
```

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE) for details.
