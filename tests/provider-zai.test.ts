/**
 * zai-coding-plan provider tests.
 *
 * The provider has two backends:
 *   1. Default — Z.ai's OpenAI-compatible endpoint at /api/coding/paas/v4
 *      with native GLM models (glm-5.1, glm-4.6, glm-4.5-air)
 *   2. Claude Code routing — when the model is `claude-code`, `cc`, or any
 *      `claude-*` alias, the brain spawns the Claude Code CLI subprocess
 *      with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` env vars set
 *      to Z.ai's Anthropic-compatible endpoint
 *
 * These tests verify the routing logic and resolution helpers without
 * needing real API access.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveProviderModelName,
  resolveProviderApiKey,
  isClaudeCodeRoutedModel,
  ZAI_OPENAI_BASE_URL,
  ZAI_ANTHROPIC_BASE_URL,
} from '../src/provider-defaults.js'

describe('zai-coding-plan provider defaults', () => {
  it('defaults to glm-5.1 when no model is specified', () => {
    expect(resolveProviderModelName('zai-coding-plan')).toBe('glm-5.1')
  })

  it('defaults to glm-5.1 when given a gpt-5 alias (the global default)', () => {
    expect(resolveProviderModelName('zai-coding-plan', 'gpt-5.4')).toBe('glm-5.1')
    expect(resolveProviderModelName('zai-coding-plan', 'gpt-5')).toBe('glm-5.1')
  })

  it('passes glm-* model names through unchanged', () => {
    expect(resolveProviderModelName('zai-coding-plan', 'glm-5.1')).toBe('glm-5.1')
    expect(resolveProviderModelName('zai-coding-plan', 'glm-4.6')).toBe('glm-4.6')
    expect(resolveProviderModelName('zai-coding-plan', 'glm-4.5-air')).toBe('glm-4.5-air')
  })

  it('passes claude-* aliases through unchanged for downstream routing', () => {
    expect(resolveProviderModelName('zai-coding-plan', 'claude-code')).toBe('claude-code')
    expect(resolveProviderModelName('zai-coding-plan', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })
})

describe('isClaudeCodeRoutedModel', () => {
  it('matches the canonical aliases', () => {
    expect(isClaudeCodeRoutedModel('claude-code')).toBe(true)
    expect(isClaudeCodeRoutedModel('cc')).toBe(true)
    expect(isClaudeCodeRoutedModel('CC')).toBe(true)
  })

  it('matches any claude-* model id', () => {
    expect(isClaudeCodeRoutedModel('claude-sonnet-4-5')).toBe(true)
    expect(isClaudeCodeRoutedModel('claude-opus-4-6')).toBe(true)
    expect(isClaudeCodeRoutedModel('claude-haiku-4-5')).toBe(true)
  })

  it('does not match GLM models', () => {
    expect(isClaudeCodeRoutedModel('glm-5.1')).toBe(false)
    expect(isClaudeCodeRoutedModel('glm-4.6')).toBe(false)
    expect(isClaudeCodeRoutedModel('glm-4.5-air')).toBe(false)
  })

  it('does not match OpenAI models', () => {
    expect(isClaudeCodeRoutedModel('gpt-4o')).toBe(false)
    expect(isClaudeCodeRoutedModel('gpt-5.4')).toBe(false)
  })
})

describe('zai-coding-plan API key resolution', () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    Object.assign(process.env, originalEnv)
  })

  it('explicit key wins over env vars', () => {
    process.env.ZAI_API_KEY = 'env-key'
    expect(resolveProviderApiKey('zai-coding-plan', 'explicit')).toBe('explicit')
  })

  it('prefers ZAI_API_KEY env var', () => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.ZAI_API_KEY = 'zai-key'
    expect(resolveProviderApiKey('zai-coding-plan')).toBe('zai-key')
  })

  it('falls back to ZAI_CODING_API_KEY', () => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.ZAI_CODING_API_KEY = 'zai-coding-key'
    expect(resolveProviderApiKey('zai-coding-plan')).toBe('zai-coding-key')
  })

  it('falls back to ANTHROPIC_AUTH_TOKEN (Claude Code redirected env)', () => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-auth'
    expect(resolveProviderApiKey('zai-coding-plan')).toBe('anthropic-auth')
  })

  it('falls back to ANTHROPIC_API_KEY as the last resort', () => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'anthropic-key'
    expect(resolveProviderApiKey('zai-coding-plan')).toBe('anthropic-key')
  })

  it('returns undefined when no keys are set', () => {
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    expect(resolveProviderApiKey('zai-coding-plan')).toBeUndefined()
  })
})

describe('zai-coding-plan endpoint constants', () => {
  it('exposes the OpenAI-compatible base URL', () => {
    expect(ZAI_OPENAI_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
  })

  it('exposes the Anthropic-compatible base URL', () => {
    expect(ZAI_ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
  })
})
