# @tangle-network/agent-browser-driver

LLM-driven browser automation agent. Observe page state via accessibility tree, decide actions via LLM, execute in a loop until the goal is achieved.

## Features

- **Stable @ref selectors** — deterministic FNV-1a hashes of role+name, so the same element keeps the same ref across observations
- **Multimodal vision** — screenshots + a11y tree sent to the LLM for layout-aware decisions
- **Post-action verification** — checks expected effects after each action
- **Stuck detection + recovery** — auto-detects loops and triggers recovery strategies
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
npm install -D playwright  # peer dependency
```

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
    model: 'gpt-4o',
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
| `model` | `string` | `'gpt-4o'` | Model name |
| `apiKey` | `string` | env var | API key |
| `baseUrl` | `string` | — | Custom endpoint (LiteLLM, etc.) |
| `headless` | `boolean` | `true` | Browser headless mode |
| `viewport` | `{ width, height }` | `1920x1080` | Browser viewport |
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
| `memory` | `{ enabled, dir }` | `disabled` | Trajectory memory |
| `projects` | `Array<{ name, config, testDir }>` | — | Named project configs |

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

## Test Runner

Run structured test suites with ground-truth verification:

```typescript
import { TestRunner } from '@tangle-network/agent-browser-driver';

const runner = new TestRunner({
  driver,
  config: { model: 'gpt-4o', vision: true },
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
agent-driver run --cases ./cases.json --model claude-sonnet-4-20250514 --concurrency 4

# Explicit config path
agent-driver run --config ./ci.config.ts --cases ./cases.json
```

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
