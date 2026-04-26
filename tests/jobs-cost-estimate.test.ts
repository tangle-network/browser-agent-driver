import { describe, it, expect } from 'vitest'
import { estimateCost, DEFAULT_PER_AUDIT_USD } from '../src/jobs/cost-estimate.js'
import type { JobSpec } from '../src/jobs/types.js'

const SPEC: JobSpec = {
  kind: 'comparative-audit',
  discover: { source: 'list', urls: [] },
}

describe('estimateCost', () => {
  it('multiplies targets by per-audit cost', () => {
    const est = estimateCost(SPEC, 100)
    expect(est.estimatedTotalUSD).toBeCloseTo(100 * DEFAULT_PER_AUDIT_USD)
  })

  it('multiplies by pages', () => {
    const est = estimateCost({ ...SPEC, audit: { pages: 3 } }, 10)
    expect(est.estimatedTotalUSD).toBeCloseTo(10 * 3 * DEFAULT_PER_AUDIT_USD)
  })

  it('flips exceedsCap when above maxCostUSD', () => {
    expect(estimateCost({ ...SPEC, maxCostUSD: 5 }, 100).exceedsCap).toBe(true)
    expect(estimateCost({ ...SPEC, maxCostUSD: 1000 }, 100).exceedsCap).toBe(false)
  })

  it('honors a custom per-audit cost', () => {
    const est = estimateCost(SPEC, 50, 0.1)
    expect(est.estimatedTotalUSD).toBeCloseTo(5)
  })
})
