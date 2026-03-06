import { describe, expect, it } from 'vitest';
import { resolveProviderModelName } from '../src/provider-defaults.js';

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
