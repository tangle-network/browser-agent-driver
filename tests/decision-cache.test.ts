/**
 * Tests for the in-session decision cache.
 *
 * Pins:
 *   - Hit/miss accounting on identical vs different keys
 *   - LRU eviction at maxEntries
 *   - TTL expiration
 *   - Budget bucketing distinguishes turn 5/20 from turn 18/20
 *   - Volatile fields stripped on cache hit (raw, tokens)
 *   - Hash key is stable across snapshot byte equality
 */

import { describe, expect, it } from 'vitest'
import { DecisionCache, type DecisionCacheKey } from '../src/runner/decision-cache.js'
import type { BrainDecision } from '../src/brain/index.js'

const SAMPLE_DECISION: BrainDecision = {
  action: { action: 'click', selector: '@b1' },
  raw: '{"action":{"action":"click","selector":"@b1"}}',
  reasoning: 'click the button',
  expectedEffect: 'modal closes',
  tokensUsed: 1500,
  inputTokens: 1400,
  outputTokens: 100,
}

function makeKey(overrides: Partial<DecisionCacheKey> = {}): DecisionCacheKey {
  return {
    snapshotHash: DecisionCache.hashSnapshot('[ref=b1] button "Click"'),
    url: 'https://example.com/page',
    goal: 'click the button',
    lastEffect: '',
    budgetBucket: 'early',
    ...overrides,
  }
}

describe('DecisionCache', () => {
  it('returns undefined on miss and increments misses', () => {
    const cache = new DecisionCache()
    expect(cache.get(makeKey())).toBeUndefined()
    expect(cache.getStats().misses).toBe(1)
    expect(cache.getStats().hits).toBe(0)
  })

  it('returns the cached decision on identical key and increments hits', () => {
    const cache = new DecisionCache()
    cache.set(makeKey(), SAMPLE_DECISION)
    const hit = cache.get(makeKey())
    expect(hit).toBeDefined()
    expect(hit?.decision.action).toEqual({ action: 'click', selector: '@b1' })
    expect(cache.getStats().hits).toBe(1)
    expect(cache.getStats().hitRate).toBe(1)
  })

  it('strips volatile telemetry fields from cached decisions', () => {
    const cache = new DecisionCache()
    cache.set(makeKey(), SAMPLE_DECISION)
    const hit = cache.get(makeKey())
    expect(hit?.decision.raw).toBe('[cached]')
    expect(hit?.decision.tokensUsed).toBe(0)
    expect(hit?.decision.inputTokens).toBe(0)
    expect(hit?.decision.outputTokens).toBe(0)
  })

  it('treats different snapshot hashes as different keys', () => {
    const cache = new DecisionCache()
    cache.set(makeKey({ snapshotHash: 'abc' }), SAMPLE_DECISION)
    expect(cache.get(makeKey({ snapshotHash: 'def' }))).toBeUndefined()
    expect(cache.get(makeKey({ snapshotHash: 'abc' }))).toBeDefined()
  })

  it('treats different URLs as different keys', () => {
    const cache = new DecisionCache()
    cache.set(makeKey({ url: 'https://a.com' }), SAMPLE_DECISION)
    expect(cache.get(makeKey({ url: 'https://b.com' }))).toBeUndefined()
  })

  it('treats different goals as different keys', () => {
    const cache = new DecisionCache()
    cache.set(makeKey({ goal: 'goal A' }), SAMPLE_DECISION)
    expect(cache.get(makeKey({ goal: 'goal B' }))).toBeUndefined()
  })

  it('treats different budget buckets as different keys', () => {
    const cache = new DecisionCache()
    cache.set(makeKey({ budgetBucket: 'early' }), SAMPLE_DECISION)
    expect(cache.get(makeKey({ budgetBucket: 'late' }))).toBeUndefined()
  })

  it('expires entries older than ttlMs', () => {
    let now = 1000
    const cache = new DecisionCache({ ttlMs: 5000, now: () => now })
    cache.set(makeKey(), SAMPLE_DECISION)
    expect(cache.get(makeKey())).toBeDefined()
    now += 6000
    expect(cache.get(makeKey())).toBeUndefined()
  })

  it('evicts oldest entry when maxEntries is exceeded', () => {
    const cache = new DecisionCache({ maxEntries: 2 })
    cache.set(makeKey({ snapshotHash: 'a' }), SAMPLE_DECISION)
    cache.set(makeKey({ snapshotHash: 'b' }), SAMPLE_DECISION)
    cache.set(makeKey({ snapshotHash: 'c' }), SAMPLE_DECISION)
    expect(cache.get(makeKey({ snapshotHash: 'a' }))).toBeUndefined()
    expect(cache.get(makeKey({ snapshotHash: 'b' }))).toBeDefined()
    expect(cache.get(makeKey({ snapshotHash: 'c' }))).toBeDefined()
  })

  it('LRU bump: a get refreshes the entry', () => {
    const cache = new DecisionCache({ maxEntries: 2 })
    cache.set(makeKey({ snapshotHash: 'a' }), SAMPLE_DECISION)
    cache.set(makeKey({ snapshotHash: 'b' }), SAMPLE_DECISION)
    cache.get(makeKey({ snapshotHash: 'a' })) // bump 'a' to most-recent
    cache.set(makeKey({ snapshotHash: 'c' }), SAMPLE_DECISION) // should evict 'b' now
    expect(cache.get(makeKey({ snapshotHash: 'a' }))).toBeDefined()
    expect(cache.get(makeKey({ snapshotHash: 'b' }))).toBeUndefined()
    expect(cache.get(makeKey({ snapshotHash: 'c' }))).toBeDefined()
  })

  it('clear() empties the cache and resets stats', () => {
    const cache = new DecisionCache()
    cache.set(makeKey(), SAMPLE_DECISION)
    cache.get(makeKey())
    cache.clear()
    expect(cache.getStats().size).toBe(0)
    expect(cache.getStats().hits).toBe(0)
    expect(cache.getStats().misses).toBe(0)
  })
})

describe('DecisionCache.budgetBucket', () => {
  it('classifies early-mid-late by ratio thresholds', () => {
    expect(DecisionCache.budgetBucket(1, 20)).toBe('early')   // 5%
    expect(DecisionCache.budgetBucket(6, 20)).toBe('early')   // 30%
    expect(DecisionCache.budgetBucket(7, 20)).toBe('mid')     // 35%
    expect(DecisionCache.budgetBucket(14, 20)).toBe('mid')    // 70%
    expect(DecisionCache.budgetBucket(15, 20)).toBe('late')   // 75%
    expect(DecisionCache.budgetBucket(20, 20)).toBe('late')   // 100%
  })

  it('handles single-turn budgets without dividing by zero', () => {
    expect(DecisionCache.budgetBucket(1, 1)).toBe('late')
    expect(DecisionCache.budgetBucket(0, 0)).toBe('early')
  })
})

describe('DecisionCache.hashKey', () => {
  it('produces stable hashes for byte-identical keys', () => {
    const k1 = makeKey()
    const k2 = makeKey()
    expect(DecisionCache.hashKey(k1)).toBe(DecisionCache.hashKey(k2))
  })

  it('produces different hashes for keys differing in any field', () => {
    const base = makeKey()
    expect(DecisionCache.hashKey(base)).not.toBe(DecisionCache.hashKey({ ...base, url: 'other' }))
    expect(DecisionCache.hashKey(base)).not.toBe(DecisionCache.hashKey({ ...base, goal: 'other' }))
    expect(DecisionCache.hashKey(base)).not.toBe(DecisionCache.hashKey({ ...base, lastEffect: 'other' }))
    expect(DecisionCache.hashKey(base)).not.toBe(DecisionCache.hashKey({ ...base, budgetBucket: 'late' }))
  })
})
