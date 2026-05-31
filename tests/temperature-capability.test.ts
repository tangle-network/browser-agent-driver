import { describe, expect, it } from 'vitest';
import { shouldSendTemperature } from '../src/provider-defaults.js';

describe('shouldSendTemperature', () => {
  it('omits temperature for reasoning models that reject it', () => {
    for (const m of [
      'gpt-5', 'gpt-5.1', 'gpt-5-mini', 'openai/gpt-5',
      'o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini',
      'claude-opus-4-8', 'claude-opus-4-8-20250805', 'claude-opus-4-9', 'claude-opus-4-10',
      'kimi-k2.6', 'kimi-k2.6-preview', 'kimi-thinking-preview',
      'deepseek-reasoner', 'deepseek-r1',
    ]) {
      expect(shouldSendTemperature(m), `${m} should NOT send temperature`).toBe(false);
    }
  });
  it('still sends temperature for models that accept it (no regression)', () => {
    for (const m of [
      'gpt-4o', 'gpt-4.1', 'claude-opus-4-1', 'claude-opus-4-1-20250805',
      'claude-sonnet-4-5', 'claude-3-5-sonnet', 'deepseek-chat', 'deepseek-v4-pro',
      'kimi-k2.5', 'kimi-k2', 'gemini-2.5-pro', 'glm-4.6',
    ]) {
      expect(shouldSendTemperature(m), `${m} should send temperature`).toBe(true);
    }
  });
  it('is case-insensitive', () => {
    expect(shouldSendTemperature('Claude-Opus-4-8')).toBe(false);
    expect(shouldSendTemperature('GPT-5')).toBe(false);
  });
});
