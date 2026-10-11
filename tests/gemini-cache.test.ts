/**
 * Wave-3 explicit Gemini cache: unit tests with a mocked fetch (the live
 * verification — cache creation + 99% cached-read on repeat calls — is in
 * the PR body; it needs a real API key).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureGeminiCache,
  geminiCacheEnabled,
  isCacheableSystemText,
  resetGeminiCachesForTest,
} from '../src/brain/gemini-cache.js'

const BIG_SYSTEM = 'x'.repeat(6000)

describe('gemini-cache', () => {
  beforeEach(() => {
    resetGeminiCachesForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.BAD_GEMINI_CACHE
  })

  it('gates on system text size (flash floor is 1024 tokens)', () => {
    expect(isCacheableSystemText('short')).toBe(false)
    expect(isCacheableSystemText(BIG_SYSTEM)).toBe(true)
  })

  it('honors the BAD_GEMINI_CACHE=0 kill switch', () => {
    expect(geminiCacheEnabled()).toBe(true)
    process.env.BAD_GEMINI_CACHE = '0'
    expect(geminiCacheEnabled()).toBe(false)
  })

  it('creates a cache once and reuses it by content key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'cachedContents/abc123' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const first = await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM })
    const second = await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM })
    expect(first).toBe('cachedContents/abc123')
    expect(second).toBe('cachedContents/abc123')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown[])[1]!.body as string)
    expect(body.model).toBe('models/gemini-2.5-flash')
    expect(body.systemInstruction.parts[0].text).toBe(BIG_SYSTEM)
    expect(body.ttl).toBe('600s')
  })

  it('creates separate caches for different system text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'cachedContents/x' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM })
    await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM + 'y' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to undefined on API failure (caller proceeds uncached)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('quota', { status: 429 })))
    const out = await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM })
    expect(out).toBeUndefined()
  })

  it('falls back to undefined on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')))
    const out = await ensureGeminiCache({ apiKey: 'k', model: 'gemini-2.5-flash', systemText: BIG_SYSTEM })
    expect(out).toBeUndefined()
  })
})
