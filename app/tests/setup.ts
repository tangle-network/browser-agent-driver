/**
 * Test setup — starts the local orchestrator + SDK adapter and returns config
 * for TangleSandboxProvider.
 *
 * Architecture:
 *   SDK client → adapter (:14096) /v1/sandboxes → orchestrator (:4095) /projects
 *
 * The adapter translates between @tangle/sandbox SDK endpoints and the
 * orchestrator's native API.
 *
 * Usage:
 *   import { ensureOrchestrator, teardownOrchestrator } from './setup.js';
 *   const config = await ensureOrchestrator();
 *   // config.sdkUrl → pass to TangleSandboxProvider.baseUrl
 *   // config.apiKey → pass to TangleSandboxProvider.apiKey
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_DEV_CONTAINER_DIR = resolve(import.meta.dirname, '../../../agent-dev-container');
const SDK_ADAPTER_PATH = resolve(
  AGENT_DEV_CONTAINER_DIR,
  'products/sandbox/sdk/tests/helpers/sdk-adapter-server.ts'
);
const ORCHESTRATOR_URL = 'http://localhost:4095';
const ADAPTER_PORT = 14096;
const HEALTH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export interface TestConfig {
  /** URL for the SDK adapter (what TangleSandboxProvider connects to) */
  sdkUrl: string;
  /** Raw orchestrator URL */
  orchestratorUrl: string;
  /** Product API key for SDK auth */
  apiKey: string;
  /** LLM API key (for agent-driver's brain) */
  llmApiKey: string;
  /** LLM provider name */
  llmProvider: 'openai' | 'anthropic';
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, label: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`${label} did not become healthy within ${timeoutMs / 1000}s`);
}

function readProductApiKey(): string | undefined {
  const envPath = resolve(AGENT_DEV_CONTAINER_DIR, 'apps/orchestrator/.env');
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(/SEED_PRODUCTS=(.+)/);
  if (!match) return undefined;
  try {
    const products = JSON.parse(match[1]) as Array<{ api_key?: string }>;
    return products[0]?.api_key;
  } catch {
    return undefined;
  }
}

function readApiSecretKey(): string | undefined {
  const envPath = resolve(AGENT_DEV_CONTAINER_DIR, 'apps/orchestrator/.env');
  if (!existsSync(envPath)) return undefined;
  const content = readFileSync(envPath, 'utf-8');
  const match = content.match(/^API_SECRET_KEY=(.+)$/m);
  return match?.[1]?.trim();
}

function findLlmApiKey(): { key: string; provider: 'openai' | 'anthropic' } {
  if (process.env.OPENAI_API_KEY) {
    return { key: process.env.OPENAI_API_KEY, provider: 'openai' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  }

  // Search agent-dev-container and blueprint-agent env files
  const envFiles = [
    resolve(AGENT_DEV_CONTAINER_DIR, 'apps/orchestrator/.env'),
    resolve(AGENT_DEV_CONTAINER_DIR, 'apps/sidecar/.env'),
    resolve(AGENT_DEV_CONTAINER_DIR, 'apps/sidecar/.env.test'),
    resolve(AGENT_DEV_CONTAINER_DIR, '../../blueprint-agent/apps/web/.dev.vars'),
  ];

  for (const fullPath of envFiles) {
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf-8');

    // Check for quoted and unquoted OPENAI_API_KEY
    const openaiMatch = content.match(/^OPENAI_API_KEY="?([^"\n]+)"?$/m);
    if (openaiMatch?.[1] && !openaiMatch[1].startsWith('#')) {
      return { key: openaiMatch[1].trim(), provider: 'openai' };
    }

    const anthropicMatch = content.match(/^(?:ANTHROPIC_API_KEY|CLAUDE_AGENT_API_KEY)="?([^"\n]+)"?$/m);
    if (anthropicMatch?.[1] && !anthropicMatch[1].startsWith('#')) {
      return { key: anthropicMatch[1].trim(), provider: 'anthropic' };
    }
  }

  throw new Error(
    'No LLM API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your environment.'
  );
}

let orchestratorProcess: ChildProcess | undefined;
let adapterStopFn: (() => Promise<void>) | undefined;

/** Start orchestrator + SDK adapter if not running */
export async function ensureOrchestrator(): Promise<TestConfig> {
  if (!existsSync(AGENT_DEV_CONTAINER_DIR)) {
    throw new Error(
      `agent-dev-container not found at ${AGENT_DEV_CONTAINER_DIR}. ` +
      'Clone it alongside agent-driver: ~/webb/agent-dev-container'
    );
  }

  // 1. Ensure orchestrator is running
  const orchestratorRunning = await isHealthy(ORCHESTRATOR_URL);
  if (!orchestratorRunning) {
    console.log('Orchestrator not running. Starting...');
    orchestratorProcess = spawn('pnpm', ['dev:orchestrator'], {
      cwd: AGENT_DEV_CONTAINER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    orchestratorProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`  [orchestrator] ${line}`);
    });
    orchestratorProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.includes('cache bypass')) console.error(`  [orchestrator:err] ${line}`);
    });

    console.log('Waiting for orchestrator health...');
    await waitForHealth(ORCHESTRATOR_URL, 'Orchestrator');
    console.log('Orchestrator ready.');
  } else {
    console.log('Orchestrator already running.');
  }

  // 2. Resolve keys — API_SECRET_KEY for orchestrator auth (Bearer token)
  const apiKey = readApiSecretKey() ?? readProductApiKey() ?? 'test-api-key';
  const llm = findLlmApiKey();
  console.log(`LLM provider: ${llm.provider} (key: ${llm.key.slice(0, 12)}...)`);

  // 3. Start SDK adapter server
  if (!existsSync(SDK_ADAPTER_PATH)) {
    throw new Error(`SDK adapter not found at ${SDK_ADAPTER_PATH}`);
  }

  // Import the adapter server from the SDK's test helpers
  const { startAdapterServer } = await import(SDK_ADAPTER_PATH) as {
    startAdapterServer: (config: {
      orchestratorUrl: string;
      orchestratorApiKey: string;
      port?: number;
      llm?: { provider: string; model: string; apiKey: string; baseUrl?: string };
    }) => Promise<{ url: string; port: number; stop: () => Promise<void> }>;
  };

  const adapter = await startAdapterServer({
    orchestratorUrl: ORCHESTRATOR_URL,
    orchestratorApiKey: apiKey,
    port: ADAPTER_PORT,
    llm: {
      provider: llm.provider,
      model: llm.provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o',
      apiKey: llm.key,
    },
  });

  adapterStopFn = adapter.stop;
  console.log(`SDK adapter running at ${adapter.url}`);

  return {
    sdkUrl: adapter.url,
    orchestratorUrl: ORCHESTRATOR_URL,
    apiKey,
    llmApiKey: llm.key,
    llmProvider: llm.provider,
  };
}

/** Shutdown what we started */
export async function teardownOrchestrator(): Promise<void> {
  if (adapterStopFn) {
    console.log('Stopping SDK adapter...');
    await adapterStopFn();
    adapterStopFn = undefined;
  }
  if (orchestratorProcess) {
    console.log('Stopping orchestrator...');
    orchestratorProcess.kill('SIGTERM');
    orchestratorProcess = undefined;
  }
}

/** Run as standalone script */
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureOrchestrator()
    .then((config) => {
      console.log('\nTest config:');
      console.log(JSON.stringify({
        ...config,
        apiKey: config.apiKey.slice(0, 12) + '...',
        llmApiKey: config.llmApiKey.slice(0, 12) + '...',
      }, null, 2));
      console.log('\nPress Ctrl+C to stop.');
      process.on('SIGINT', () => {
        teardownOrchestrator().then(() => process.exit(0));
      });
    })
    .catch((err) => {
      console.error('Setup failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
