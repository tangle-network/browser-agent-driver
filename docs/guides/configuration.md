# Configuration Reference

## Config File

Create `agent-browser-driver.config.ts` in your project root:

```typescript
import { defineConfig } from '@tangle-network/agent-browser-driver'

export default defineConfig({
  model: 'gpt-5.4',
  headless: true,
  concurrency: 4,
  maxTurns: 30,
  timeoutMs: 300_000,
  outputDir: './test-results',
  reporters: ['junit', 'html'],
  memory: { enabled: true },
})
```

Auto-detected by CLI and programmatic API. CLI flags override config values. Supports `.ts`, `.js`, `.mjs`.

## DriverConfig

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `'openai' \| 'anthropic' \| 'google' \| 'codex-cli' \| 'claude-code' \| 'sandbox-backend'` | `'openai'` | LLM provider |
| `model` | `string` | `'gpt-5.4'` | Model name |
| `apiKey` | `string` | env var | API key |
| `baseUrl` | `string` | — | Custom endpoint (LiteLLM, etc.) |
| `browser` | `'chromium' \| 'firefox' \| 'webkit'` | `'chromium'` | Browser engine |
| `headless` | `boolean` | `true` | Headless mode |
| `viewport` | `{ width, height }` | `1920x1080` | Browser viewport |
| `browserArgs` | `string[]` | `[]` | Extra Chromium launch args |
| `storageState` | `string` | — | Playwright storage state JSON (pre-authenticated session) |
| `maxTurns` | `number` | `30` | Max turns per test |
| `timeoutMs` | `number` | `600000` | Per-test timeout |
| `concurrency` | `number` | `1` | Parallel workers |
| `llmTimeoutMs` | `number` | `60000` | Timeout per LLM call |
| `retries` | `number` | `3` | Retries for transient failures |
| `retryDelayMs` | `number` | `1000` | Base backoff between retries |
| `screenshotInterval` | `number` | `5` | Capture every N turns |
| `vision` | `boolean` | `true` | Send screenshots to LLM |
| `goalVerification` | `boolean` | `true` | Verify goal completion |
| `qualityThreshold` | `number` | `0` | Min quality 1-10 (0 = skip) |
| `outputDir` | `string` | `'./agent-results'` | Artifact output dir |
| `reporters` | `('json' \| 'markdown' \| 'html' \| 'junit')[]` | `['json']` | Report formats |
| `sinks` | `ArtifactSink[]` | — | Custom artifact sinks |
| `resourceBlocking` | `ResourceBlockingOptions` | — | Block analytics/images/media |
| `wallet` | `WalletConfig` | — | Extension mode for wallet flows |
| `memory` | `{ enabled, dir, traceScoring, traceTtlDays }` | disabled | Trajectory memory |
| `supervisor` | `SupervisorConfig` | enabled | Hard-stall intervention policy |
| `projects` | `Array<{ name, config, testDir, testMatch }>` | — | Named project configs |

### Adaptive Model Routing

Route verification calls to a cheaper model while keeping the primary model for decisions.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `adaptiveModelRouting` | `boolean` | `false` | Enable routing |
| `navModel` | `string` | — | Cheap model for verification |
| `navProvider` | `string` | same as `provider` | Provider for nav model |

### Sandbox Backend

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sandboxBackendType` | `string` | env/config | Sidecar backend type |
| `sandboxBackendProfile` | `string` | — | Sidecar profile/preset ID |
| `sandboxBackendProvider` | `string` | — | Sidecar provider override |

## Personas

- `auto` — derives a persona from goal + URL. Recommended default.
- `alice-blueprint-builder` — realistic product flows with blocker handling, partner route hints, substantive completion criteria.
