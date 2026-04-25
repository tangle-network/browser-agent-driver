import { describe, expect, it } from 'vitest';
import { resolveProviderApiKey, resolveProviderModelName } from '../src/provider-defaults.js';

describe('resolveProviderModelName', () => {
  it('defaults claude-code to sonnet when model is omitted', () => {
    expect(resolveProviderModelName('claude-code')).toBe('sonnet');
  });

  it('replaces inherited gpt-5 defaults for claude-code', () => {
    expect(resolveProviderModelName('claude-code', 'gpt-5.4')).toBe('sonnet');
  });

  it('preserves explicit claude-code model choices', () => {
    expect(resolveProviderModelName('claude-code', 'opus')).toBe('opus');
  });

  it('preserves non-claude provider defaults', () => {
    expect(resolveProviderModelName('openai')).toBe('gpt-5.4');
  });

  it('defaults cli-bridge to the codex harness', () => {
    expect(resolveProviderModelName('cli-bridge')).toBe('codex/gpt-5.5');
    expect(resolveProviderModelName('cli-bridge', 'gpt-5.5')).toBe('codex/gpt-5.5');
  });

  it('preserves explicit cli-bridge harness model choices', () => {
    expect(resolveProviderModelName('cli-bridge', 'claude-code/sonnet')).toBe('claude-code/sonnet');
  });

  it('defaults sandbox-backend claude runs to sonnet when backend type is claude-code', () => {
    expect(
      resolveProviderModelName('sandbox-backend', undefined, {
        sandboxBackendType: 'claude-code',
      }),
    ).toBe('sonnet');
  });

  it('defaults sandbox-backend codex runs to gpt-5 when backend type is codex', () => {
    expect(
      resolveProviderModelName('sandbox-backend', undefined, {
        sandboxBackendType: 'codex',
      }),
    ).toBe('gpt-5');
  });
});

describe('resolveProviderApiKey', () => {
  it('keeps claude-code isolated from OPENAI_API_KEY fallback', () => {
    expect(
      resolveProviderApiKey('claude-code', undefined, {
        OPENAI_API_KEY: 'openai-key',
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('keeps openai isolated from ANTHROPIC_API_KEY fallback', () => {
    expect(
      resolveProviderApiKey('openai', undefined, {
        ANTHROPIC_API_KEY: 'anthropic-key',
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('uses provider-specific env fallbacks when available', () => {
    expect(
      resolveProviderApiKey('claude-code', undefined, {
        ANTHROPIC_API_KEY: 'anthropic-key',
      } as NodeJS.ProcessEnv),
    ).toBe('anthropic-key');
    expect(
      resolveProviderApiKey('codex-cli', undefined, {
        OPENAI_API_KEY: 'openai-key',
      } as NodeJS.ProcessEnv),
    ).toBe('openai-key');
  });

  it('uses cli-bridge bearer tokens without falling back across providers', () => {
    expect(
      resolveProviderApiKey('cli-bridge', undefined, {
        CLI_BRIDGE_BEARER: 'bridge-token',
        OPENAI_API_KEY: 'openai-key',
      } as NodeJS.ProcessEnv),
    ).toBe('bridge-token');
  });
});
