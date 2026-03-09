import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { defineConfig, defineTests, loadConfig, mergeConfig, toAgentConfig } from '../src/config.js';
import type { DriverConfig } from '../src/config.js';

const DEFINE_CONFIG_IMPORT_URL = new URL('../src/config.ts', import.meta.url).href;

describe('defineConfig', () => {
  it('returns the same config object (identity function)', () => {
    const config: DriverConfig = { model: 'gpt-4o', headless: true };
    expect(defineConfig(config)).toBe(config);
  });
});

describe('defineTests', () => {
  it('returns the same test cases array (identity function)', () => {
    const tests = [{ id: 'a', name: 'Test A', startUrl: 'http://localhost', goal: 'Do something' }];
    expect(defineTests(tests)).toBe(tests);
  });
});

describe('mergeConfig', () => {
  it('merges scalar values with last-wins', () => {
    const result = mergeConfig({ model: 'a' }, { model: 'b' });
    expect(result.model).toBe('b');
  });

  it('deep merges objects (viewport, memory)', () => {
    const result = mergeConfig(
      { memory: { enabled: true, dir: '.mem' } },
      { memory: { enabled: false } },
    );
    expect(result.memory).toEqual({ enabled: false, dir: '.mem' });
  });

  it('replaces arrays with last-wins for reporters', () => {
    const result = mergeConfig(
      { reporters: ['json'] },
      { reporters: ['junit'] },
    );
    expect(result.reporters).toEqual(['junit']);
  });

  it('skips undefined values', () => {
    const result = mergeConfig({ model: 'gpt-4o' }, { model: undefined });
    expect(result.model).toBe('gpt-4o');
  });

  it('merges three configs in order', () => {
    const result = mergeConfig(
      { model: 'a', provider: 'openai' },
      { model: 'b' },
      { model: 'c', concurrency: 4 },
    );
    expect(result.model).toBe('c');
    expect(result.provider).toBe('openai');
    expect(result.concurrency).toBe(4);
  });

  it('preserves nested object keys when override has undefined values', () => {
    const result = mergeConfig(
      { wallet: { enabled: true, userDataDir: '.wallet-profile' } },
      { wallet: { enabled: undefined, extensionPaths: ['wallet-ext'] } },
    );
    expect(result.wallet).toEqual({
      enabled: true,
      userDataDir: '.wallet-profile',
      extensionPaths: ['wallet-ext'],
    });
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file found in directory', async () => {
    // loadConfig with no explicit path searches CWD for config files.
    // In a temp dir with no config files, findConfigFile returns undefined → defaults.
    const origCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const config = await loadConfig();
      expect(config).toBeDefined();
      expect(config.model).toBe('gpt-5.4'); // default
      expect(config.headless).toBe(true);  // default
    } finally {
      process.chdir(origCwd);
    }
  });

  it('loads config from an explicit .mjs path', async () => {
    const configPath = path.join(tmpDir, 'test.config.mjs');
    fs.writeFileSync(configPath, 'export default { model: "test-model", concurrency: 8 };\n');

    const config = await loadConfig(configPath);
    expect(config.model).toBe('test-model');
    expect(config.concurrency).toBe(8);
    // Defaults are merged in
    expect(config.headless).toBe(true);
  });

  it('merges file config with defaults', async () => {
    const configPath = path.join(tmpDir, 'test.config.mjs');
    fs.writeFileSync(configPath, 'export default { provider: "anthropic" };\n');

    const config = await loadConfig(configPath);
    expect(config.provider).toBe('anthropic');
    expect(config.maxTurns).toBe(30); // default
    expect(config.vision).toBe(true); // default
  });

  it('loads config from an explicit .ts path that uses defineConfig', async () => {
    const configPath = path.join(tmpDir, 'browser-agent-driver.config.ts');
    fs.writeFileSync(
      configPath,
      [
        `import { defineConfig } from ${JSON.stringify(DEFINE_CONFIG_IMPORT_URL)};`,
        'export default defineConfig({',
        '  model: "ts-config-model",',
        '  browserArgs: ["--lang=en-US"],',
        '  wallet: {',
        '    enabled: true,',
        '    extensionPaths: ["./extensions/metamask"],',
        '    userDataDir: "./.wallet-profile",',
        '  },',
        '});',
      ].join('\n'),
    );

    const config = await loadConfig(configPath);
    expect(config.model).toBe('ts-config-model');
    expect(config.browserArgs).toEqual(['--lang=en-US']);
    expect(config.wallet).toEqual({
      enabled: true,
      extensionPaths: ['./extensions/metamask'],
      userDataDir: './.wallet-profile',
    });
    // Defaults still merge in
    expect(config.headless).toBe(true);
  });

  it('auto-discovers browser-agent-driver.config.ts from parent directories', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const nestedDir = path.join(projectRoot, 'packages', 'web');
    fs.mkdirSync(nestedDir, { recursive: true });

    const configPath = path.join(projectRoot, 'browser-agent-driver.config.ts');
    fs.writeFileSync(
      configPath,
      [
        `import { defineConfig } from ${JSON.stringify(DEFINE_CONFIG_IMPORT_URL)};`,
        'export default defineConfig({ model: "auto-discovered-ts", concurrency: 3 });',
      ].join('\n'),
    );

    const origCwd = process.cwd();
    process.chdir(nestedDir);
    try {
      const config = await loadConfig();
      expect(config.model).toBe('auto-discovered-ts');
      expect(config.concurrency).toBe(3);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('throws when config file contains invalid syntax', async () => {
    const configPath = path.join(tmpDir, 'broken.config.mjs');
    fs.writeFileSync(configPath, 'export default { model: "broken",;\n');

    await expect(loadConfig(configPath)).rejects.toThrow();
  });
});

describe('toAgentConfig', () => {
  it('extracts AgentConfig fields from DriverConfig', () => {
    const driverConfig: DriverConfig = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
      llmTimeoutMs: 20000,
      retries: 1,
      retryDelayMs: 250,
      vision: true,
      goalVerification: false,
      qualityThreshold: 7,
      // These should NOT appear in AgentConfig
      concurrency: 4,
      headless: false,
      outputDir: './results',
    };

    const agentConfig = toAgentConfig(driverConfig);
    expect(agentConfig.provider).toBe('anthropic');
    expect(agentConfig.model).toBe('claude-sonnet-4-20250514');
    expect(agentConfig.apiKey).toBe('sk-test');
    expect(agentConfig.llmTimeoutMs).toBe(20000);
    expect(agentConfig.retries).toBe(1);
    expect(agentConfig.retryDelayMs).toBe(250);
    expect(agentConfig.vision).toBe(true);
    expect(agentConfig.goalVerification).toBe(false);
    expect(agentConfig.qualityThreshold).toBe(7);
    // Verify no extra keys leaked through
    expect('concurrency' in agentConfig).toBe(false);
    expect('headless' in agentConfig).toBe(false);
  });

  it('maps supervisor config into AgentConfig', () => {
    const driverConfig: DriverConfig = {
      provider: 'openai',
      model: 'gpt-5.2',
      supervisor: {
        enabled: true,
        model: 'gpt-5.2-mini',
        provider: 'openai',
        useVision: false,
        minTurnsBeforeInvoke: 4,
        cooldownTurns: 2,
        maxInterventions: 3,
        hardStallWindow: 5,
      },
    };

    const agentConfig = toAgentConfig(driverConfig);
    expect(agentConfig.supervisor).toEqual({
      enabled: true,
      model: 'gpt-5.2-mini',
      provider: 'openai',
      useVision: false,
      minTurnsBeforeInvoke: 4,
      cooldownTurns: 2,
      maxInterventions: 3,
      hardStallWindow: 5,
    });
  });

  it('maps microPlan config into AgentConfig', () => {
    const driverConfig: DriverConfig = {
      model: 'gpt-5.2',
      microPlan: {
        enabled: true,
        maxActionsPerTurn: 3,
      },
    };

    const agentConfig = toAgentConfig(driverConfig);
    expect(agentConfig.microPlan).toEqual({
      enabled: true,
      maxActionsPerTurn: 3,
    });
  });

  it('maps scout config into AgentConfig', () => {
    const driverConfig: DriverConfig = {
      model: 'gpt-5.2',
      scout: {
        enabled: true,
        model: 'gpt-5.2-mini',
        provider: 'openai',
        useVision: false,
        maxCandidates: 3,
        minTopScore: 11,
        maxScoreGap: 2,
        readOnlyTop2Challenger: true,
      },
    };

    const agentConfig = toAgentConfig(driverConfig);
    expect(agentConfig.scout).toEqual({
      enabled: true,
      model: 'gpt-5.2-mini',
      provider: 'openai',
      useVision: false,
      maxCandidates: 3,
      minTopScore: 11,
      maxScoreGap: 2,
      readOnlyTop2Challenger: true,
    });
  });

  it('maps custom systemPrompt when provided', () => {
    const driverConfig: DriverConfig = {
      model: 'gpt-5.2',
      systemPrompt: 'Custom prompt for experiment',
    };
    const agentConfig = toAgentConfig(driverConfig);
    expect(agentConfig.systemPrompt).toBe('Custom prompt for experiment');
  });
});
