/**
 * Configuration system for agent-browser-driver.
 *
 * Supports config files (agent-browser-driver.config.ts/js/mjs),
 * programmatic config via defineConfig(), and CLI flag overrides.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentConfig, TestCase } from './types.js';
import type { ArtifactSink } from './artifacts/types.js';
import type { ResourceBlockingOptions } from './drivers/types.js';

export interface DriverConfig {
  /** Execution profile preset (applies launch/runtime defaults) */
  profile?: 'default' | 'stealth' | 'benchmark-webbench' | 'benchmark-webbench-stealth' | 'benchmark-webvoyager';
  browser?: 'chromium' | 'firefox' | 'webkit';

  // LLM
  provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  model?: string;
  adaptiveModelRouting?: boolean;
  navModel?: string;
  navProvider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  apiKey?: string;
  baseUrl?: string;
  sandboxBackendType?: string;
  sandboxBackendProfile?: string;
  sandboxBackendProvider?: string;
  systemPrompt?: string;

  // Browser
  headless?: boolean;
  viewport?: { width: number; height: number };
  browserArgs?: string[];
  wallet?: {
    enabled?: boolean;
    extensionPaths?: string[];
    userDataDir?: string;
    autoApprove?: boolean;
    password?: string;
    tickMs?: number;
    actionSelectors?: string[];
    promptPaths?: string[];
    connectSelectors?: string[];
    connectorSelectors?: string[];
    preflight?: {
      enabled?: boolean;
      seedUrls?: string[];
      requestAccounts?: boolean;
      clearStorage?: boolean;
      accountsTimeoutMs?: number;
      maxChainSwitchAttempts?: number;
      chain?: {
        id?: number;
        hex?: string;
        rpcUrl?: string;
        name?: string;
        nativeCurrency?: {
          name: string;
          symbol: string;
          decimals: number;
        };
      };
    };
  };
  /** Playwright storageState file path for pre-authenticated sessions */
  storageState?: string;

  // Execution
  maxTurns?: number;
  timeoutMs?: number;
  concurrency?: number;
  llmTimeoutMs?: number;
  compactFirstTurn?: boolean;
  retries?: number;
  retryDelayMs?: number;
  screenshotInterval?: number;
  vision?: boolean;
  visionStrategy?: 'always' | 'never' | 'auto';
  goalVerification?: boolean;
  qualityThreshold?: number;
  microPlan?: {
    enabled?: boolean;
    maxActionsPerTurn?: number;
  };
  scout?: {
    enabled?: boolean;
    model?: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
    useVision?: boolean;
    maxCandidates?: number;
    minTopScore?: number;
    maxScoreGap?: number;
    readOnlyTop2Challenger?: boolean;
  };
  observability?: {
    enabled?: boolean;
    captureConsole?: boolean;
    captureNetwork?: boolean;
    tracePolicy?: 'off' | 'on-failure' | 'always';
    maxConsoleEntries?: number;
    maxNetworkEntries?: number;
  };

  // Output
  outputDir?: string;
  reporters?: Array<'json' | 'markdown' | 'html' | 'junit'>;
  sinks?: ArtifactSink[];

  // Performance
  /** Disable CDP fast-path for observe() (fall back to Playwright ariaSnapshot) */
  disableCdp?: boolean;

  // Resource blocking
  resourceBlocking?: ResourceBlockingOptions;

  // Memory
  memory?: {
    enabled?: boolean;
    dir?: string;
    traceScoring?: boolean;
    traceTtlDays?: number;
  };

  supervisor?: {
    enabled?: boolean;
    model?: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
    useVision?: boolean;
    minTurnsBeforeInvoke?: number;
    cooldownTurns?: number;
    maxInterventions?: number;
    hardStallWindow?: number;
  };

  // Projects (like vitest/playwright)
  projects?: Array<{
    name: string;
    config?: Partial<DriverConfig>;
    testDir?: string;
    testMatch?: string[];
  }>;
}

const DEFAULTS: DriverConfig = {
  browser: 'chromium',
  provider: 'openai',
  model: 'gpt-5.4',
  adaptiveModelRouting: false,
  headless: true,
  viewport: { width: 1920, height: 1080 },
  maxTurns: 30,
  timeoutMs: 600_000,
  concurrency: 1,
  llmTimeoutMs: 60_000,
  compactFirstTurn: false,
  retries: 3,
  retryDelayMs: 1000,
  screenshotInterval: 5,
  vision: true,
  goalVerification: true,
  qualityThreshold: 0,
  microPlan: { enabled: false, maxActionsPerTurn: 2 },
  scout: {
    enabled: false,
    useVision: false,
    maxCandidates: 3,
    minTopScore: 12,
    maxScoreGap: 4,
    readOnlyTop2Challenger: false,
  },
  observability: {
    enabled: true,
    captureConsole: true,
    captureNetwork: true,
    tracePolicy: 'on-failure',
    maxConsoleEntries: 200,
    maxNetworkEntries: 200,
  },
  outputDir: './agent-results',
  reporters: ['json'],
  memory: { enabled: false, dir: '.agent-memory', traceScoring: false, traceTtlDays: 30 },
  supervisor: {
    enabled: true,
    useVision: true,
    minTurnsBeforeInvoke: 5,
    cooldownTurns: 3,
    maxInterventions: 2,
    hardStallWindow: 4,
  },
};

/** Identity function for type inference and IDE autocomplete in config files */
export function defineConfig(config: DriverConfig): DriverConfig {
  return config;
}

/** Identity function for type inference in test case files */
export function defineTests(tests: TestCase[]): TestCase[] {
  return tests;
}

const CONFIG_FILENAMES = [
  'agent-browser-driver.config.ts',
  'agent-browser-driver.config.js',
  'agent-browser-driver.config.mjs',
];

/**
 * Load config from a file. Searches CWD and parent directories for
 * agent-browser-driver.config.{ts,js,mjs}. Returns defaults if no config found.
 */
export async function loadConfig(configPath?: string): Promise<DriverConfig> {
  const resolved = configPath
    ? path.resolve(configPath)
    : findConfigFile(process.cwd());

  if (!resolved) {
    return { ...DEFAULTS };
  }

  const imported = await import(resolved);
  const raw: DriverConfig = imported.default ?? imported;

  return mergeConfig(DEFAULTS, raw);
}

// Arrays that should concatenate (combining sinks is the common pattern).
// All other arrays (reporters, browserArgs, projects) replace — last wins.
const CONCAT_KEYS = new Set(['sinks']);

/**
 * Deep merge multiple config objects. Last-wins for scalar values and arrays,
 * concatenation for `sinks` only, shallow merge for objects.
 */
export function mergeConfig(...configs: Partial<DriverConfig>[]): DriverConfig {
  const result: Record<string, unknown> = {};

  for (const cfg of configs) {
    for (const [key, value] of Object.entries(cfg)) {
      if (value === undefined) continue;

      const existing = result[key];

      if (Array.isArray(value) && Array.isArray(existing) && CONCAT_KEYS.has(key)) {
        // Concat only for sinks
        result[key] = [...existing, ...value];
      } else if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        existing !== null &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
      ) {
        // Shallow merge objects (memory, viewport)
        const cleanedObject = Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([, nestedValue]) => nestedValue !== undefined),
        );
        result[key] = { ...(existing as Record<string, unknown>), ...cleanedObject };
      } else {
        // Scalars and arrays (reporters, browserArgs, projects): last wins
        result[key] = value;
      }
    }
  }

  return result as DriverConfig;
}

/** Convert DriverConfig to the AgentConfig used by AgentRunner/TestRunner */
export function toAgentConfig(config: DriverConfig): AgentConfig {
  return {
    provider: config.provider,
    model: config.model,
    adaptiveModelRouting: config.adaptiveModelRouting,
    navModel: config.navModel,
    navProvider: config.navProvider,
    sandboxBackendType: config.sandboxBackendType,
    sandboxBackendProfile: config.sandboxBackendProfile,
    sandboxBackendProvider: config.sandboxBackendProvider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    llmTimeoutMs: config.llmTimeoutMs,
    compactFirstTurn: config.compactFirstTurn,
    retries: config.retries,
    retryDelayMs: config.retryDelayMs,
    vision: config.vision,
    visionStrategy: config.visionStrategy,
    goalVerification: config.goalVerification,
    qualityThreshold: config.qualityThreshold,
    microPlan: config.microPlan
      ? {
          enabled: config.microPlan.enabled,
          maxActionsPerTurn: config.microPlan.maxActionsPerTurn,
        }
      : undefined,
    scout: config.scout
      ? {
          enabled: config.scout.enabled,
          model: config.scout.model,
          provider: config.scout.provider,
          useVision: config.scout.useVision,
          maxCandidates: config.scout.maxCandidates,
          minTopScore: config.scout.minTopScore,
          maxScoreGap: config.scout.maxScoreGap,
          readOnlyTop2Challenger: config.scout.readOnlyTop2Challenger,
        }
      : undefined,
    observability: config.observability
      ? {
          enabled: config.observability.enabled,
          captureConsole: config.observability.captureConsole,
          captureNetwork: config.observability.captureNetwork,
          tracePolicy: config.observability.tracePolicy,
          maxConsoleEntries: config.observability.maxConsoleEntries,
          maxNetworkEntries: config.observability.maxNetworkEntries,
        }
      : undefined,
    traceScoring: config.memory?.traceScoring,
    traceTtlDays: config.memory?.traceTtlDays,
    ...(config.supervisor
      ? {
          supervisor: {
            enabled: config.supervisor.enabled,
            model: config.supervisor.model,
            provider: config.supervisor.provider,
            useVision: config.supervisor.useVision,
            minTurnsBeforeInvoke: config.supervisor.minTurnsBeforeInvoke,
            cooldownTurns: config.supervisor.cooldownTurns,
            maxInterventions: config.supervisor.maxInterventions,
            hardStallWindow: config.supervisor.hardStallWindow,
          },
        }
      : {}),
  };
}

/** Search up directory tree for config file */
function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);

  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // root
    dir = parent;
  }

  return undefined;
}
