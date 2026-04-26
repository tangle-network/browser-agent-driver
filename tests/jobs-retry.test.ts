import { describe, it, expect } from 'vitest'
import { withRetry, isRetryableDefault, DEFAULT_RETRY_POLICY, type RetryPolicy } from '../src/jobs/retry.js'

const NO_DELAY: Pick<RetryPolicy, 'backoffFn'> = { backoffFn: () => 0 }

describe('isRetryableDefault', () => {
  it('returns true for transient errors', () => {
    expect(isRetryableDefault(new Error('fetch failed'))).toBe(true)
    expect(isRetryableDefault(new Error('CDX returned 503'))).toBe(true)
    expect(isRetryableDefault(new Error('socket hang up'))).toBe(true)
    expect(isRetryableDefault(new Error('ECONNRESET while reading'))).toBe(true)
    expect(isRetryableDefault(new Error('rate limit hit (429)'))).toBe(true)
    expect(isRetryableDefault(new Error('server timeout'))).toBe(true)
  })

  it('returns false for deterministic errors', () => {
    expect(isRetryableDefault(new Error('CDX returned 404'))).toBe(false)
    expect(isRetryableDefault(new Error('schema validation failed'))).toBe(false)
    expect(isRetryableDefault(new Error('cloudflare challenge detected'))).toBe(false)
    expect(isRetryableDefault(new Error('marked not retryable upstream'))).toBe(false)
  })

  it('returns false for unknown errors (no false positive)', () => {
    expect(isRetryableDefault(new Error('whatever happened'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    let calls = 0
    const out = await withRetry(async () => {
      calls += 1
      return 'ok'
    }, { ...DEFAULT_RETRY_POLICY, ...NO_DELAY })
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries up to maxAttempts on retryable errors', async () => {
    let calls = 0
    const out = await withRetry(async () => {
      calls += 1
      if (calls < 3) throw new Error('CDX returned 503')
      return 'ok'
    }, { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, ...NO_DELAY })
    expect(out).toBe('ok')
    expect(calls).toBe(3)
  })

  it('throws non-retryable errors immediately', async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw new Error('CDX returned 404')
    }, { ...DEFAULT_RETRY_POLICY, ...NO_DELAY })).rejects.toThrow(/404/)
    expect(calls).toBe(1)
  })

  it('exhausts retries and tags the final error', async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls += 1
      throw new Error('CDX returned 503')
    }, { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, ...NO_DELAY })).rejects.toThrow(/\[after 2 attempts\]/)
    expect(calls).toBe(2)
  })

  it('fires onRetry hook with attempt number and delay', async () => {
    const seen: Array<{ attempt: number; msg: string; delay: number }> = []
    let calls = 0
    await withRetry(async () => {
      calls += 1
      if (calls < 2) throw new Error('timeout')
      return 'ok'
    }, {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 3,
      backoffFn: () => 7,
      onRetry: (attempt, err, delay) => seen.push({ attempt, msg: err.message, delay }),
    })
    expect(seen).toEqual([{ attempt: 1, msg: 'timeout', delay: 7 }])
  })

  it('uses the custom backoffFn for delay', async () => {
    const delays: number[] = []
    let calls = 0
    await withRetry(async () => {
      calls += 1
      if (calls < 4) throw new Error('timeout')
      return 'ok'
    }, {
      ...DEFAULT_RETRY_POLICY,
      maxAttempts: 4,
      backoffFn: (attempt) => {
        delays.push(attempt)
        return 0
      },
    })
    expect(delays).toEqual([0, 1, 2])
  })
})
