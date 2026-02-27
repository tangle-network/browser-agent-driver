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

## Configuration

```typescript
interface AgentConfig {
  model?: string;           // LLM model (default: gpt-4o)
  apiKey?: string;          // OpenAI API key (default: OPENAI_API_KEY env)
  baseUrl?: string;         // Custom API base URL
  vision?: boolean;         // Enable vision/multimodal (default: true)
  debug?: boolean;          // Enable debug logging
  maxHistoryTurns?: number; // Conversation history limit (default: 10)
  retries?: number;         // Retry count on failures (default: 3)
  retryDelayMs?: number;    // Delay between retries (default: 1000)
  qualityThreshold?: number; // Min quality score for auto-evaluate (0 = skip)
  llmTimeoutMs?: number;    // Timeout per LLM request (default: 60000)
}

interface Scenario {
  goal: string;             // Natural language goal
  startUrl?: string;        // Starting URL
  maxTurns?: number;        // Max cycles (default: 20)
  signal?: AbortSignal;     // External cancellation
}
```

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

## License

Dual-licensed under MIT and Apache 2.0. See [LICENSE](./LICENSE) for details.
