import { describe, expect, it } from 'vitest';
import { mergeConfig, toAgentConfig } from '../src/config.js';
import type { DriverConfig } from '../src/config.js';

/**
 * Tests for CLI-like configuration merging — simulates the overlay
 * pipeline: DEFAULTS + file config + CLI overrides + profile/mode presets.
 */

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

describe('CLI config overlay pipeline', () => {
  it('CLI --model overrides default', () => {
    const merged = mergeConfig(DEFAULTS, { model: 'claude-sonnet-4-20250514' });
    expect(merged.model).toBe('claude-sonnet-4-20250514');
    expect(merged.provider).toBe('openai'); // unchanged default
  });

  it('CLI --provider + --model override file config', () => {
    const fileConfig: Partial<DriverConfig> = { provider: 'openai', model: 'gpt-5.4' };
    const cliOverrides: Partial<DriverConfig> = { provider: 'anthropic', model: 'claude-opus-4-20250514' };
    const merged = mergeConfig(DEFAULTS, fileConfig, cliOverrides);
    expect(merged.provider).toBe('anthropic');
    expect(merged.model).toBe('claude-opus-4-20250514');
  });

  it('CLI --max-turns overrides file config and default', () => {
    const fileConfig: Partial<DriverConfig> = { maxTurns: 20 };
    const cliOverrides: Partial<DriverConfig> = { maxTurns: 10 };
    const merged = mergeConfig(DEFAULTS, fileConfig, cliOverrides);
    expect(merged.maxTurns).toBe(10);
  });

  it('CLI scout flags shallow-merge with defaults', () => {
    const cliOverrides: Partial<DriverConfig> = {
      scout: { enabled: true, model: 'gpt-5.4-mini' },
    };
    const merged = mergeConfig(DEFAULTS, cliOverrides);
    expect(merged.scout?.enabled).toBe(true);
    expect(merged.scout?.model).toBe('gpt-5.4-mini');
    // Shallow merge preserves unoverridden keys from DEFAULTS.scout
    expect(merged.scout?.useVision).toBe(false);
    expect(merged.scout?.maxCandidates).toBe(3);
  });

  it('CLI supervisor flags merge with defaults', () => {
    const cliOverrides: Partial<DriverConfig> = {
      supervisor: { minTurnsBeforeInvoke: 3 },
    };
    const merged = mergeConfig(DEFAULTS, cliOverrides);
    expect(merged.supervisor?.minTurnsBeforeInvoke).toBe(3);
    expect(merged.supervisor?.enabled).toBe(true); // default preserved
    expect(merged.supervisor?.maxInterventions).toBe(2); // default preserved
  });

  it('CLI memory flags merge with defaults', () => {
    const cliOverrides: Partial<DriverConfig> = {
      memory: { enabled: true },
    };
    const merged = mergeConfig(DEFAULTS, cliOverrides);
    expect(merged.memory?.enabled).toBe(true);
    expect(merged.memory?.dir).toBe('.agent-memory'); // default preserved
  });

  it('fast-explore mode presets override defaults', () => {
    // Simulate mode=fast-explore CLI overlay
    const fastExplorePresets: Partial<DriverConfig> = {
      vision: false,
      screenshotInterval: 0,
      goalVerification: true,
      qualityThreshold: 0,
      resourceBlocking: { blockAnalytics: true },
    };
    const merged = mergeConfig(DEFAULTS, fastExplorePresets);
    expect(merged.vision).toBe(false);
    expect(merged.screenshotInterval).toBe(0);
    expect(merged.goalVerification).toBe(true);
  });

  it('full-evidence mode presets override defaults', () => {
    const fullEvidencePresets: Partial<DriverConfig> = {
      vision: true,
      screenshotInterval: 3,
      goalVerification: true,
    };
    const merged = mergeConfig(DEFAULTS, fullEvidencePresets);
    expect(merged.vision).toBe(true);
    expect(merged.screenshotInterval).toBe(3);
  });

  it('stealth profile presets are applied correctly', () => {
    const stealthPresets: Partial<DriverConfig> = {
      headless: false,
      goalVerification: true,
      screenshotInterval: 2,
      resourceBlocking: { blockAnalytics: true },
      microPlan: { enabled: true, maxActionsPerTurn: 2 },
    };
    const merged = mergeConfig(DEFAULTS, stealthPresets);
    expect(merged.headless).toBe(false);
    expect(merged.microPlan?.enabled).toBe(true);
    expect(merged.resourceBlocking?.blockAnalytics).toBe(true);
  });

  it('benchmark-webbench profile presets are applied correctly', () => {
    const benchPresets: Partial<DriverConfig> = {
      llmTimeoutMs: 20_000,
      compactFirstTurn: true,
      retries: 1,
      retryDelayMs: 250,
      vision: false,
      screenshotInterval: 0,
      goalVerification: true,
      resourceBlocking: { blockAnalytics: true, blockImages: true, blockMedia: true },
      microPlan: { enabled: true, maxActionsPerTurn: 2 },
    };
    const merged = mergeConfig(DEFAULTS, benchPresets);
    expect(merged.llmTimeoutMs).toBe(20_000);
    expect(merged.compactFirstTurn).toBe(true);
    expect(merged.retries).toBe(1);
    expect(merged.retryDelayMs).toBe(250);
    expect(merged.vision).toBe(false);
    expect(merged.resourceBlocking?.blockImages).toBe(true);
  });
});

describe('CLI config → AgentConfig conversion', () => {
  it('produces an AgentConfig with all expected fields', () => {
    const merged = mergeConfig(DEFAULTS, { model: 'test-model', provider: 'anthropic' });
    const agent = toAgentConfig(merged);
    expect(agent.model).toBe('test-model');
    expect(agent.provider).toBe('anthropic');
    expect(agent.vision).toBe(true);
    expect(agent.goalVerification).toBe(true);
    expect(agent.supervisor?.enabled).toBe(true);
  });

  it('maps adaptive routing fields', () => {
    const merged = mergeConfig(DEFAULTS, {
      adaptiveModelRouting: true,
      navModel: 'gpt-5.4-mini',
      navProvider: 'openai',
    });
    const agent = toAgentConfig(merged);
    expect(agent.adaptiveModelRouting).toBe(true);
    expect(agent.navModel).toBe('gpt-5.4-mini');
    expect(agent.navProvider).toBe('openai');
  });

  it('maps trace scoring from memory config', () => {
    const merged = mergeConfig(DEFAULTS, {
      memory: { traceScoring: true, traceTtlDays: 14 },
    });
    const agent = toAgentConfig(merged);
    expect(agent.traceScoring).toBe(true);
    expect(agent.traceTtlDays).toBe(14);
  });

  it('maps sandbox backend fields', () => {
    const merged = mergeConfig(DEFAULTS, {
      provider: 'sandbox-backend',
      sandboxBackendType: 'docker',
      sandboxBackendProfile: 'gpu-1',
      sandboxBackendProvider: 'openai',
    });
    const agent = toAgentConfig(merged);
    expect(agent.provider).toBe('sandbox-backend');
    expect(agent.sandboxBackendType).toBe('docker');
    expect(agent.sandboxBackendProfile).toBe('gpu-1');
    expect(agent.sandboxBackendProvider).toBe('openai');
  });

  it('maps observability config', () => {
    const merged = mergeConfig(DEFAULTS, {
      observability: {
        enabled: true,
        captureConsole: false,
        tracePolicy: 'always',
      },
    });
    const agent = toAgentConfig(merged);
    expect(agent.observability?.enabled).toBe(true);
    expect(agent.observability?.captureConsole).toBe(false);
    expect(agent.observability?.tracePolicy).toBe('always');
  });

  it('does not include driver-level keys in AgentConfig', () => {
    const merged = mergeConfig(DEFAULTS, { outputDir: '/tmp/out', concurrency: 8 });
    const agent = toAgentConfig(merged);
    expect('outputDir' in agent).toBe(false);
    expect('concurrency' in agent).toBe(false);
    expect('headless' in agent).toBe(false);
    expect('browser' in agent).toBe(false);
  });
});
