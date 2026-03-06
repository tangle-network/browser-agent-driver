import { describe, expect, it } from 'vitest';
import { resolveProviderApiKey, resolveProviderModelName } from '../src/provider-defaults.js';

describe('resolveProviderModelName', () => {
  it('defaults claude-code to sonnet when model is omitted', () => {
    expect(resolveProviderModelName('claude-code')).toBe('sonnet');
  });

  it('replaces inherited gpt-5 defaults for claude-code', () => {
    expect(resolveProviderModelName('claude-code', 'gpt-5.2')).toBe('sonnet');
  });

  it('preserves explicit claude-code model choices', () => {
    expect(resolveProviderModelName('claude-code', 'opus')).toBe('opus');
  });

  it('preserves non-claude provider defaults', () => {
    expect(resolveProviderModelName('openai')).toBe('gpt-5.2');
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
});
