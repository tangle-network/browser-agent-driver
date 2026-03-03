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
  // LLM
  provider?: 'openai' | 'anthropic' | 'google';
  model?: string;
  apiKey?: string;
  baseUrl?: string;

  // Browser
  headless?: boolean;
  viewport?: { width: number; height: number };
  browserArgs?: string[];
  wallet?: {
    enabled?: boolean;
    extensionPaths?: string[];
    userDataDir?: string;
  };

  // Execution
  maxTurns?: number;
  timeoutMs?: number;
  concurrency?: number;
  screenshotInterval?: number;
  vision?: boolean;
  goalVerification?: boolean;
  qualityThreshold?: number;

  // Output
  outputDir?: string;
  reporters?: Array<'json' | 'markdown' | 'html' | 'junit'>;
  sinks?: ArtifactSink[];

  // Resource blocking
  resourceBlocking?: ResourceBlockingOptions;

  // Memory
  memory?: {
    enabled?: boolean;
    dir?: string;
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
  provider: 'openai',
  model: 'gpt-4o',
  headless: true,
  viewport: { width: 1920, height: 1080 },
  maxTurns: 30,
  timeoutMs: 600_000,
  concurrency: 1,
  screenshotInterval: 5,
  vision: true,
  goalVerification: true,
  qualityThreshold: 0,
  outputDir: './agent-results',
  reporters: ['json'],
  memory: { enabled: false, dir: '.agent-memory' },
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
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    vision: config.vision,
    goalVerification: config.goalVerification,
    qualityThreshold: config.qualityThreshold,
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
