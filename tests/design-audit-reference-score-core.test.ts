import { describe, it, expect } from 'vitest'
import {
  deriveHeadlineScore,
  toDimensionScores,
  toDesignSystemScore,
} from '../src/design/audit/reference/engine/score-core.js'
import type {
  QualityAssessment,
  MeasurementBundle,
  Dimension,
  DimensionScore,
} from '../src/design/audit/reference/contracts.js'
import { DIMENSIONS } from '../src/design/audit/score-types.js'

const measurements = (hasBlockingIssues: boolean): MeasurementBundle => ({
  contrast: { totalChecked: 100, aaFailures: [], aaaFailures: [], summary: { aaPassRate: 1, aaaPassRate: 1 } },
  a11y: { ran: true, violations: [], passes: 50 },
  hasBlockingIssues,
})

const quality = (over: Partial<QualityAssessment> = {}): QualityAssessment => ({
  overallWinRate: 0.5,
  comparisons: 4,
  ...over,
})

describe('deriveHeadlineScore', () => {
  it('maps win-rate onto 0-10 monotonically with no blocking issues', () => {
    const rates = [0, 0.25, 0.5, 0.75, 1]
    const scores = rates.map((w) => deriveHeadlineScore(quality({ overallWinRate: w }), measurements(false)))
    expect(scores).toEqual([0, 2.5, 5, 7.5, 10])
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1])
    }
  })

  it('caps a high score when measurements flag blocking issues', () => {
    const clean = deriveHeadlineScore(quality({ overallWinRate: 0.9 }), measurements(false))
    const blocked = deriveHeadlineScore(quality({ overallWinRate: 0.9 }), measurements(true))
    expect(clean).toBe(9)
    expect(blocked).toBe(6)
    expect(blocked).toBeLessThan(clean)
  })

  it('does not raise a low score when blocking issues are present', () => {
    const low = deriveHeadlineScore(quality({ overallWinRate: 0.3 }), measurements(true))
    expect(low).toBe(3)
  })

  it('is deterministic', () => {
    const q = quality({ overallWinRate: 0.62 })
    expect(deriveHeadlineScore(q, measurements(false))).toBe(deriveHeadlineScore(q, measurements(false)))
  })
})

describe('toDimensionScores', () => {
  it('returns a rich DimensionScore for all 5 dimensions and satisfies the precomputedScores shape', () => {
    const scores = toDimensionScores(quality({ comparisons: 10 }))
    for (const dim of DIMENSIONS) {
      expect(scores[dim]).toBeDefined()
      expect(scores[dim].score).toBeGreaterThanOrEqual(1)
      expect(scores[dim].score).toBeLessThanOrEqual(10)
      expect(scores[dim].range[0]).toBeLessThanOrEqual(scores[dim].score)
      expect(scores[dim].score).toBeLessThanOrEqual(scores[dim].range[1])
      expect(Array.isArray(scores[dim].primaryFindings)).toBe(true)
    }
    // compile-time proof it drops into stage 8's precomputedScores unchanged
    const precomputed: Record<Dimension, DimensionScore> = scores
    expect(Object.keys(precomputed).length).toBe(5)
  })

  it('scores each judged dimension from its own win-rate (no overall number stamped across dims)', () => {
    const scores = toDimensionScores(
      quality({
        comparisons: 10,
        dimensionWinRates: { product_intent: 1, visual_craft: 0, trust_clarity: 0.5 },
      }),
    )
    expect(scores.product_intent.score).toBe(10)
    expect(scores.visual_craft.score).toBe(1)
    expect(scores.trust_clarity.score).toBe(5)
    // judged dims carry real confidence; their summaries cite the comparison count
    expect(scores.product_intent.confidence).not.toBe('low')
    expect(scores.product_intent.summary).toMatch(/win-rate/i)
  })

  it('fills a dimension with no win-rate as an explicit low-confidence placeholder', () => {
    const scores = toDimensionScores(
      quality({ comparisons: 10, dimensionWinRates: { trust_clarity: 0.5 } }),
    )
    // workflow had no signal: low confidence, full-uncertainty range, explicit summary
    expect(scores.workflow.confidence).toBe('low')
    expect(scores.workflow.range).toEqual([1, 10])
    expect(scores.workflow.summary).toMatch(/not independently judged/i)
    // a judged 0.5 and an unassessed dim can share score 5 but differ in confidence
    expect(scores.trust_clarity.score).toBe(5)
    expect(scores.trust_clarity.confidence).not.toBe('low')
  })

  it('derives confidence and range width from the comparison count', () => {
    const high = toDimensionScores(quality({ comparisons: 8, dimensionWinRates: { workflow: 0.6 } })).workflow
    const medium = toDimensionScores(quality({ comparisons: 4, dimensionWinRates: { workflow: 0.6 } })).workflow
    const low = toDimensionScores(quality({ comparisons: 2, dimensionWinRates: { workflow: 0.6 } })).workflow
    expect(high.confidence).toBe('high')
    expect(medium.confidence).toBe('medium')
    expect(low.confidence).toBe('low')
    const width = (d: typeof high): number => d.range[1] - d.range[0]
    expect(width(high)).toBeLessThan(width(medium))
    expect(width(medium)).toBeLessThan(width(low))
  })

  it('marks every dimension unassessed when no per-dim win-rates were gathered', () => {
    const scores = toDimensionScores(quality({ dimensionWinRates: undefined }))
    for (const dim of DIMENSIONS) {
      expect(scores[dim].confidence).toBe('low')
      expect(scores[dim].summary).toMatch(/not independently judged/i)
    }
  })
})

describe('toDesignSystemScore', () => {
  it('fills all 8 design-system axes from the overall win-rate', () => {
    const score = toDesignSystemScore(quality({ overallWinRate: 0.9 }))
    const expected = 9
    expect(score).toEqual({
      layout: expected,
      typography: expected,
      color: expected,
      spacing: expected,
      components: expected,
      interactions: expected,
      accessibility: expected,
      polish: expected,
    })
  })

  it('is monotonic in the overall win-rate', () => {
    const lo = toDesignSystemScore(quality({ overallWinRate: 0.3 })).layout
    const hi = toDesignSystemScore(quality({ overallWinRate: 0.8 })).layout
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
})
