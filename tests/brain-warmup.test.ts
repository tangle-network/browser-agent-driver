/**
 * Tests for `Brain.warmup` — the connection pre-warm hook called from
 * `BrowserAgent.run` in parallel with the first observe.
 *
 * The actual warmup makes a 1-token generateText call which would hit a real
 * API. These tests verify that warmup() is a safe no-op for CLI-spawning
 * providers and respects BAD_NO_WARMUP.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Brain } from '../src/brain/index.js'

describe('Brain.warmup', () => {
  const originalEnv = process.env.BAD_NO_WARMUP

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BAD_NO_WARMUP
    } else {
      process.env.BAD_NO_WARMUP = originalEnv
    }
  })

  it('is a no-op when BAD_NO_WARMUP=1', async () => {
    process.env.BAD_NO_WARMUP = '1'
    const brain = new Brain({ provider: 'openai', apiKey: 'test-key' })
    // Should resolve without throwing or making any network calls
    await expect(brain.warmup()).resolves.toBeUndefined()
  })

  it('skips for codex-cli provider (subprocess, no connection to warm)', async () => {
    const brain = new Brain({ provider: 'codex-cli', apiKey: 'test-key' })
    await expect(brain.warmup()).resolves.toBeUndefined()
  })

  it('skips for claude-code provider', async () => {
    const brain = new Brain({ provider: 'claude-code', apiKey: 'test-key' })
    await expect(brain.warmup()).resolves.toBeUndefined()
  })

  it('skips for sandbox-backend provider', async () => {
    const brain = new Brain({ provider: 'sandbox-backend' })
    await expect(brain.warmup()).resolves.toBeUndefined()
  })

  it('swallows network errors silently (best-effort)', async () => {
    // Use a bogus base URL so the warmup ping fails immediately
    const brain = new Brain({
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:1', // closed port
    })
    // Best-effort: must not throw even when the connection fails
    await expect(brain.warmup()).resolves.toBeUndefined()
  })
})
