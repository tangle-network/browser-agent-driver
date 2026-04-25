import { describe, expect, it } from 'vitest';
import {
  defineConfig,
  mergeConfig,
  buildBrowserLaunchPlan,
  toAgentConfig,
} from '../src/index.js';

describe('library usage', () => {
  it('supports programmatic config composition with defineConfig + mergeConfig', () => {
    const projectConfig = defineConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      browserArgs: ['--lang=en-US'],
      wallet: {
        enabled: true,
        extensionPaths: ['./extensions/metamask'],
      },
      vision: true,
      goalVerification: true,
      qualityThreshold: 7,
    });

    const runtimeOverrides = {
      headless: true,
      concurrency: 4,
      wallet: { userDataDir: './.wallet-profile' },
    };

    const merged = mergeConfig(projectConfig, runtimeOverrides);
    expect(merged.provider).toBe('anthropic');
    expect(merged.model).toBe('claude-sonnet-4-20250514');
    expect(merged.browserArgs).toEqual(['--lang=en-US']);
    expect(merged.wallet).toEqual({
      enabled: true,
      extensionPaths: ['./extensions/metamask'],
      userDataDir: './.wallet-profile',
    });
  });

  it('builds a wallet-safe launch plan from programmatic config', () => {
    const config = defineConfig({
      browserArgs: ['--lang=en-US'],
      headless: true,
      concurrency: 5,
      wallet: {
        enabled: true,
        extensionPaths: ['./extensions/metamask'],
        userDataDir: './.wallet-profile',
      },
    });

    const plan = buildBrowserLaunchPlan(config, { cwd: '/repo' });

    expect(plan.walletMode).toBe(true);
    expect(plan.headless).toBe(true);
    expect(plan.concurrency).toBe(1);
    expect(plan.extensionPaths).toEqual(['/repo/extensions/metamask']);
    expect(plan.userDataDir).toBe('/repo/.wallet-profile');
    expect(plan.browserArgs).toContain('--lang=en-US');
    expect(plan.browserArgs).toContain('--disable-extensions-except=/repo/extensions/metamask');
    expect(plan.browserArgs).toContain('--load-extension=/repo/extensions/metamask');
    expect(plan.browserArgs).toContain('--disable-blink-features=AutomationControlled');
  });

  it('maps programmatic DriverConfig to AgentConfig without leaking browser-only fields', () => {
    const driverConfig = defineConfig({
      provider: 'google',
      model: 'gemini-2.5-pro',
      apiKey: 'test-key',
      baseUrl: 'https://llm-proxy.example',
      vision: false,
      goalVerification: false,
      qualityThreshold: 8,
      headless: false,
      wallet: { enabled: true },
      browserArgs: ['--lang=en-US'],
    });

    const agentConfig = toAgentConfig(driverConfig);

    expect(agentConfig).toEqual({
      provider: 'google',
      model: 'gemini-2.5-pro',
      apiKey: 'test-key',
      baseUrl: 'https://llm-proxy.example',
      vision: false,
      goalVerification: false,
      qualityThreshold: 8,
    });
    expect('wallet' in agentConfig).toBe(false);
    expect('headless' in agentConfig).toBe(false);
  });
});
