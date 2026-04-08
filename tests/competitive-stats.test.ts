/**
 * Tests for scripts/lib/stats.mjs — the deterministic statistical primitives
 * the bench harnesses (run-ab-experiment, run-multi-rep, run-competitive)
 * all share. These run as plain unit tests since the lib has no I/O.
 *
 * The lib is a .mjs file with no types; we cast through `unknown` to import
 * it from a TypeScript test file.
 */

import { describe, expect, it } from 'vitest'
// @ts-expect-error mjs import without types — primitives are documented in the lib
import * as stats from '../scripts/lib/stats.mjs'

describe('stats — central tendency', () => {
  it('mean of empty array is 0', () => {
    expect(stats.mean([])).toBe(0)
  })

  it('mean of [1,2,3,4,5] is 3', () => {
    expect(stats.mean([1, 2, 3, 4, 5])).toBe(3)
  })

  it('stddev of empty/single is 0', () => {
    expect(stats.stddev([])).toBe(0)
    expect(stats.stddev([42])).toBe(0)
  })

  it('stddev uses sample (n-1) denominator', () => {
    // [1,2,3,4,5]: mean 3, deviations 4+1+0+1+4=10, sample var 10/4=2.5
    expect(stats.stddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 5)
  })

  it('median picks the middle for odd-length', () => {
    expect(stats.median([1, 2, 3, 4, 5])).toBe(3)
  })

  it('median averages the two middles for even-length', () => {
    expect(stats.median([1, 2, 3, 4])).toBe(2.5)
  })

  it('quantile interpolates between adjacent ranks', () => {
    expect(stats.quantile([1, 2, 3, 4, 5], 0)).toBe(1)
    expect(stats.quantile([1, 2, 3, 4, 5], 1)).toBe(5)
    expect(stats.quantile([1, 2, 3, 4, 5], 0.25)).toBe(2)
    expect(stats.quantile([1, 2, 3, 4, 5], 0.75)).toBe(4)
    expect(stats.quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
  })

  it('describe bundles n/mean/stddev/min/median/p95/max', () => {
    const d = stats.describe([10, 20, 30, 40, 50])
    expect(d.n).toBe(5)
    expect(d.mean).toBe(30)
    expect(d.min).toBe(10)
    expect(d.max).toBe(50)
    expect(d.median).toBe(30)
  })
})

describe('stats — Wilson interval', () => {
  it('returns [0,0] for n=0', () => {
    expect(stats.wilsonInterval(0, 0)).toEqual([0, 0])
  })

  it('5/5 successes has lower bound > 0.5 and upper bound = 1', () => {
    const [lo, hi] = stats.wilsonInterval(5, 5)
    expect(lo).toBeGreaterThan(0.5)
    expect(hi).toBe(1)
  })

  it('0/5 successes has upper bound < 0.5 and lower bound = 0', () => {
    const [lo, hi] = stats.wilsonInterval(0, 5)
    expect(lo).toBe(0)
    expect(hi).toBeLessThan(0.5)
  })

  it('50/100 brackets 0.5 symmetrically (large-n)', () => {
    const [lo, hi] = stats.wilsonInterval(50, 100)
    expect(lo).toBeGreaterThan(0.39)
    expect(lo).toBeLessThan(0.41)
    expect(hi).toBeGreaterThan(0.59)
    expect(hi).toBeLessThan(0.61)
  })
})

describe('stats — bootstrap CIs', () => {
  it('bootstrapMean95 of constant sample = constant', () => {
    const [lo, hi] = stats.bootstrapMean95([5, 5, 5, 5, 5])
    expect(lo).toBe(5)
    expect(hi).toBe(5)
  })

  it('bootstrapMean95 brackets the true mean for a large sample', () => {
    // Build a sample with known mean ~50.
    const sample = Array.from({ length: 100 }, (_, i) => i + 1)
    const [lo, hi] = stats.bootstrapMean95(sample, 2000, 42)
    expect(lo).toBeGreaterThan(40)
    expect(hi).toBeLessThan(60)
    // The true mean is 50.5
    const m = stats.mean(sample)
    expect(m).toBeGreaterThan(lo)
    expect(m).toBeLessThan(hi)
  })

  it('bootstrapDiff95 brackets a known positive difference', () => {
    // treatment ~100, control ~50 → diff ~50
    const treatment = Array.from({ length: 50 }, (_, i) => 95 + (i % 11))
    const control = Array.from({ length: 50 }, (_, i) => 45 + (i % 11))
    const [lo, hi] = stats.bootstrapDiff95(treatment, control, 2000, 42)
    expect(lo).toBeGreaterThan(40)
    expect(hi).toBeLessThan(60)
  })

  it('bootstrapDiff95 of identical samples brackets 0', () => {
    const x = [10, 11, 12, 13, 14, 15]
    const [lo, hi] = stats.bootstrapDiff95(x, x, 2000, 42)
    expect(lo).toBeLessThan(0.1)
    expect(hi).toBeGreaterThan(-0.1)
  })

  it('bootstrap is reproducible for the same seed', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const a = stats.bootstrapMean95(s, 1000, 1234)
    const b = stats.bootstrapMean95(s, 1000, 1234)
    expect(a).toEqual(b)
  })
})

describe('stats — Cohen d', () => {
  it('returns 0 for identical samples', () => {
    expect(stats.cohenD([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(0)
  })

  it('returns large positive d when treatment is dramatically higher', () => {
    const d = stats.cohenD([100, 101, 102, 103], [10, 11, 12, 13])
    expect(d).toBeGreaterThan(0.8)
    expect(stats.classifyEffectSize(d)).toBe('large')
  })

  it('returns small d for samples that overlap heavily', () => {
    // Overlapping ranges 8-15 and 9-16 — d should be small/trivial.
    const d = stats.cohenD(
      [9, 10, 11, 12, 13, 14, 15, 16],
      [8, 9, 10, 11, 12, 13, 14, 15],
    )
    expect(stats.classifyEffectSize(d)).toMatch(/trivial|small/)
  })

  it('returns 0 for samples with no variance', () => {
    expect(stats.cohenD([5, 5, 5], [5, 5, 5])).toBe(0)
  })
})

describe('stats — Mann-Whitney U', () => {
  it('returns p ~1 for identical samples', () => {
    const r = stats.mannWhitneyU([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])
    expect(r.p).toBeGreaterThan(0.9)
  })

  it('returns small p for clearly separated samples', () => {
    // n1+n2 = 12, well above the n>=8 threshold for normal approx.
    const r = stats.mannWhitneyU([100, 101, 102, 103, 104, 105], [1, 2, 3, 4, 5, 6])
    expect(r.p).toBeLessThan(0.05)
  })

  it('handles ties correctly via average ranks', () => {
    const r = stats.mannWhitneyU([1, 2, 2, 3], [1, 2, 2, 3])
    // With identical samples + continuity correction the small-sample p is
    // around 0.88, not exactly 1. The point is "well above any rejection
    // threshold" — assert > 0.5.
    expect(r.p).toBeGreaterThan(0.5)
  })
})

describe('stats — spreadVerdict (CLAUDE.md rigor)', () => {
  it('lower-direction win: challenger mean below baseline by more than worst spread', () => {
    // baseline mean 100, spread 10. challenger mean 50, spread 5. delta -50 > -10 → win
    const v = stats.spreadVerdict(
      [48, 50, 52, 49, 53],   // challenger
      [95, 100, 105, 98, 102], // baseline
      'lower',
    )
    expect(v).toBe('win')
  })

  it('lower-direction comparable: delta within worst spread', () => {
    // baseline mean ~50 (range 30-70 → spread 40), challenger mean ~45 (range 30-60 → spread 30)
    // delta = -5, worst spread = 40 → comparable
    const v = stats.spreadVerdict([30, 45, 60], [30, 50, 70], 'lower')
    expect(v).toBe('comparable')
  })

  it('lower-direction regression: challenger mean above baseline by more than worst spread', () => {
    const v = stats.spreadVerdict([95, 100, 105], [48, 50, 52], 'lower')
    expect(v).toBe('regression')
  })

  it('higher-direction win: pass rate clearly higher', () => {
    const v = stats.spreadVerdict([0.95, 1.0, 1.0], [0.5, 0.55, 0.6], 'higher')
    expect(v).toBe('win')
  })
})
