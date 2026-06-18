import { describe, it, expect } from 'vitest'
import { planJudgeBudget, mapWithConcurrency } from '../src/design/audit/reference/engine/budget.js'
import type { EngineBudget } from '../src/design/audit/reference/contracts.js'

const budget = (over: Partial<EngineBudget> = {}): EngineBudget => ({
  maxGenerationCalls: 3,
  maxJudgeCalls: 100,
  judgeReps: 1,
  concurrency: 4,
  screenThenValidate: false,
  ...over,
})

// Total judge calls a plan implies: (directionPairs + qualityPairs) * 2 slot orders * reps.
const planCalls = (p: { directionPairs: number; qualityPairs: number; reps: number }): number =>
  (p.directionPairs + p.qualityPairs) * 2 * p.reps

describe('planJudgeBudget', () => {
  it('fits the full per-dimension quality leg when the budget affords it', () => {
    const plan = planJudgeBudget(3, 4, budget({ maxJudgeCalls: 100, judgeReps: 1 }), 5)
    // C(3,2)=3 direction pairs; k*dims = 4*5 = 20 quality pairs
    expect(plan).toEqual({ directionPairs: 3, qualityPairs: 20, reps: 1, qualityDimensions: 5 })
    expect(planCalls(plan)).toBe(46)
    expect(planCalls(plan)).toBeLessThanOrEqual(100)
  })

  it('drops qualityDimensions to 0 (overall-only) when the full set does not fit', () => {
    const plan = planJudgeBudget(3, 4, budget({ maxJudgeCalls: 30, judgeReps: 1 }), 5)
    // full per-dim would be 46 > 30, so the dimension leg is dropped, not faked
    expect(plan.qualityDimensions).toBe(0)
    expect(plan.qualityPairs).toBe(4) // overall-only: one comparison per exemplar
    expect(plan.reps).toBe(1)
    expect(planCalls(plan)).toBeLessThanOrEqual(30)
  })

  it('drops dimensions before reducing reps (dims are opt-in, reps debias)', () => {
    const plan = planJudgeBudget(3, 4, budget({ maxJudgeCalls: 30, judgeReps: 2 }), 5)
    // full per-dim at reps 2 = 92 > 30; overall-only at reps 2 = 28 <= 30
    expect(plan.qualityDimensions).toBe(0)
    expect(plan.reps).toBe(2)
    expect(planCalls(plan)).toBeLessThanOrEqual(30)
  })

  it('walks reps down to 1 once dimensions are already overall-only', () => {
    const plan = planJudgeBudget(3, 4, budget({ maxJudgeCalls: 20, judgeReps: 3 }), 0)
    // overall-only: reps 3 = 42, reps 2 = 28, reps 1 = 14 (the first to fit <= 20)
    expect(plan.qualityDimensions).toBe(0)
    expect(plan.reps).toBe(1)
    expect(planCalls(plan)).toBeLessThanOrEqual(20)
  })

  it('emits no direction pairs for a single direction', () => {
    const plan = planJudgeBudget(1, 2, budget({ maxJudgeCalls: 100 }), 0)
    expect(plan.directionPairs).toBe(0)
    expect(plan.qualityPairs).toBe(2)
  })

  it('caps the pairs themselves under a pathologically small budget', () => {
    const plan = planJudgeBudget(3, 4, budget({ maxJudgeCalls: 4, judgeReps: 1 }), 0)
    // affordable pairs = floor(4/2) = 2, prioritising direction pairs
    expect(plan.directionPairs).toBe(2)
    expect(plan.qualityPairs).toBe(0)
    expect(plan.qualityDimensions).toBe(0)
    expect(planCalls(plan)).toBeLessThanOrEqual(4)
  })
})

describe('mapWithConcurrency', () => {
  it('returns an empty array for empty input', async () => {
    const out = await mapWithConcurrency<number, number>([], 4, async (x) => x)
    expect(out).toEqual([])
  })

  it('never exceeds N in flight and preserves input order', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i)
    let inFlight = 0
    let peak = 0
    const out = await mapWithConcurrency(items, 3, async (item) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      // later items finish sooner, so completion order != input order
      await new Promise((r) => setTimeout(r, (12 - item) % 7))
      inFlight--
      return item * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBe(3)
    expect(out).toEqual(items.map((i) => i * 2))
  })

  it('treats a non-positive concurrency as serial (peak 1)', async () => {
    const items = [1, 2, 3, 4]
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(items, 0, async (item) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return item
    })
    expect(peak).toBe(1)
  })

  it('propagates the first rejection', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6]
    await expect(
      mapWithConcurrency(items, 2, async (item) => {
        if (item === 5) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')
  })
})
