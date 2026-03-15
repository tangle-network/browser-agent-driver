import { describe, expect, it, vi } from 'vitest'
import { detectCaptcha, isSolvable, canAttemptSolve, solveCaptcha } from '../src/captcha.js'
import type { CaptchaType } from '../src/captcha.js'

function mockPage(evaluateResult: unknown) {
  return {
    url: () => 'https://example.com/page',
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  } as unknown as import('playwright').Page
}

describe('detectCaptcha', () => {
  it('returns null when no CAPTCHA is found', async () => {
    const page = mockPage(null)
    const result = await detectCaptcha(page)
    expect(result).toBeNull()
  })

  it('detects reCAPTCHA v2 from DOM', async () => {
    const page = mockPage({ type: 'recaptcha-v2', siteKey: '6LeIxAcTAAAA' })
    const result = await detectCaptcha(page)
    expect(result).toEqual({
      type: 'recaptcha-v2',
      siteKey: '6LeIxAcTAAAA',
      pageUrl: 'https://example.com/page',
    })
  })

  it('detects reCAPTCHA v3 (invisible)', async () => {
    const page = mockPage({ type: 'recaptcha-v3', siteKey: '6LeIxAcV3AAA' })
    const result = await detectCaptcha(page)
    expect(result).toEqual({
      type: 'recaptcha-v3',
      siteKey: '6LeIxAcV3AAA',
      pageUrl: 'https://example.com/page',
    })
  })

  it('detects hCaptcha', async () => {
    const page = mockPage({ type: 'hcaptcha', siteKey: '10000000-ffff-ffff-ffff-000000000001' })
    const result = await detectCaptcha(page)
    expect(result).toEqual({
      type: 'hcaptcha',
      siteKey: '10000000-ffff-ffff-ffff-000000000001',
      pageUrl: 'https://example.com/page',
    })
  })

  it('detects Cloudflare Turnstile', async () => {
    const page = mockPage({ type: 'turnstile', siteKey: '0x4AAAAAAADnPIDROrmt1Wwj' })
    const result = await detectCaptcha(page)
    expect(result).toEqual({
      type: 'turnstile',
      siteKey: '0x4AAAAAAADnPIDROrmt1Wwj',
      pageUrl: 'https://example.com/page',
    })
  })

  it('detects generic image challenge', async () => {
    const page = mockPage({ type: 'image-challenge', siteKey: undefined })
    const result = await detectCaptcha(page)
    expect(result).toEqual({
      type: 'image-challenge',
      siteKey: undefined,
      pageUrl: 'https://example.com/page',
    })
  })
})

describe('isSolvable', () => {
  it('returns true for recaptcha-v2', () => {
    expect(isSolvable('recaptcha-v2')).toBe(true)
  })

  it.each([
    'recaptcha-v3',
    'hcaptcha',
    'turnstile',
    'image-challenge',
  ] satisfies CaptchaType[])('returns false for %s', (type) => {
    expect(isSolvable(type)).toBe(false)
  })
})

describe('canAttemptSolve', () => {
  it('returns false for empty evidence', () => {
    expect(canAttemptSolve([])).toBe(false)
  })

  it('returns true when evidence contains captcha signal', () => {
    expect(canAttemptSolve(['captcha', 'bot-detection'])).toBe(true)
  })

  it('returns true when evidence contains verify-human signal', () => {
    expect(canAttemptSolve(['verify-human'])).toBe(true)
  })

  it('returns true for partial match (e.g. recaptcha)', () => {
    expect(canAttemptSolve(['recaptcha-widget'])).toBe(true)
  })

  it('returns false when evidence has only cloudflare signals', () => {
    expect(canAttemptSolve(['cloudflare-challenge', 'cloudflare-ray'])).toBe(false)
  })

  it('returns false when evidence has only generic bot signals', () => {
    expect(canAttemptSolve(['bot-detection', 'waf-block'])).toBe(false)
  })
})

describe('solveCaptcha', () => {
  it('returns error when no captcha detected', async () => {
    const page = mockPage(null)
    const model = {} as import('ai').LanguageModel
    const result = await solveCaptcha(page, model)
    expect(result.success).toBe(false)
    expect(result.error).toBe('no captcha detected')
    expect(result.attempts).toBe(0)
    expect(result.attemptLog).toEqual([])
  })

  it('returns error for unsolvable type', async () => {
    const page = mockPage({ type: 'turnstile', siteKey: 'abc' })
    const model = {} as import('ai').LanguageModel
    const result = await solveCaptcha(page, model)
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsolvable type: turnstile')
    expect(result.type).toBe('turnstile')
    expect(result.attempts).toBe(0)
  })

  it('returns error for recaptcha-v3 (behavioral, no visual challenge)', async () => {
    const page = mockPage({ type: 'recaptcha-v3', siteKey: 'key' })
    const model = {} as import('ai').LanguageModel
    const result = await solveCaptcha(page, model)
    expect(result.success).toBe(false)
    expect(result.error).toBe('unsolvable type: recaptcha-v3')
  })
})
