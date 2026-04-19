import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure-JS helper, intentionally not typed (scripts/lib/)
import { compare, decideVerdict, firstMode, roundNum } from '../scripts/lib/macro-promotion.mjs'

function makeSummary(mode: string, stats: {
  passRate: number
  turnsMean: number
  costMean: number
  durationMeanMs?: number
  turnsMin?: number
  turnsMax?: number
  costMin?: number
  costMax?: number
  reps?: number
}) {
  return {
    perModeStats: {
      [mode]: {
        reps: stats.reps ?? 3,
        passRate: stats.passRate,
        turnsUsed: { n: stats.reps ?? 3, mean: stats.turnsMean, min: stats.turnsMin ?? stats.turnsMean, max: stats.turnsMax ?? stats.turnsMean },
        costUsd: { n: stats.reps ?? 3, mean: stats.costMean, min: stats.costMin ?? stats.costMean, max: stats.costMax ?? stats.costMean },
        durationMs: { n: stats.reps ?? 3, mean: stats.durationMeanMs ?? 0, min: 0, max: 0 },
      },
    },
  }
}

describe('macro-promotion — firstMode', () => {
  it('returns null when no stats', () => {
    expect(firstMode({})).toBeNull()
    expect(firstMode({ perModeStats: {} })).toBeNull()
  })

  it('returns the first mode when present', () => {
    const s = makeSummary('fast-explore', { passRate: 1, turnsMean: 5, costMean: 0.01 })
    const mode = firstMode(s)
    expect(mode.passRate).toBe(1)
  })
})

describe('macro-promotion — compare', () => {
  it('computes deltas across modes', () => {
    const baseline = makeSummary('fast-explore', { passRate: 1, turnsMean: 8, costMean: 0.05 })
    const treatment = makeSummary('fast-explore', { passRate: 1, turnsMean: 5, costMean: 0.04 })
    const out = compare(baseline, treatment)
    expect(out.deltas.passRate).toBe(0)
    expect(out.deltas.turnsMean).toBe(-3)
    expect(out.deltas.costMean).toBe(-0.01)
  })

  it('returns missing deltas when one side is missing', () => {
    const out = compare({}, makeSummary('x', { passRate: 1, turnsMean: 5, costMean: 0.01 }))
    expect(out.deltas).toBeUndefined()
  })
})

describe('macro-promotion — decideVerdict', () => {
  it('promotes on turn-count win with pass rate held', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 8, costMean: 0.05 }),
      makeSummary('m', { passRate: 1, turnsMean: 5, costMean: 0.05 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('promote')
  })

  it('promotes on cost win with pass rate held', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 8, costMean: 0.05 }),
      makeSummary('m', { passRate: 1, turnsMean: 8, costMean: 0.03 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('promote')
  })

  it('rejects when pass rate drops', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 8, costMean: 0.05 }),
      makeSummary('m', { passRate: 0.66, turnsMean: 5, costMean: 0.03 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('reject')
  })

  it('rejects when maxTurnsMean is violated', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 4, costMean: 0.05 }),
      makeSummary('m', { passRate: 1, turnsMean: 6, costMean: 0.05 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0, maxTurnsMean: 5 })).toBe('reject')
  })

  it('inconclusive when no win, no regression', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 5, costMean: 0.05 }),
      makeSummary('m', { passRate: 1, turnsMean: 5, costMean: 0.05 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('inconclusive')
  })

  it('treats sub-0.5-turn drop as neutral, not promote', () => {
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 5.0, costMean: 0.05 }),
      makeSummary('m', { passRate: 1, turnsMean: 4.8, costMean: 0.05 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('inconclusive')
  })

  it('refuses to promote when the delta is smaller than either side\'s spread', () => {
    // Baseline spread is 3 turns (4/7/10), treatment spread is 2 turns (3/4/5).
    // Delta mean is -2 turns, but spread dominates — this is noise, not a win.
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 7, costMean: 0.05, turnsMin: 4, turnsMax: 10 }),
      makeSummary('m', { passRate: 1, turnsMean: 4, costMean: 0.05, turnsMin: 3, turnsMax: 5 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('inconclusive')
  })

  it('promotes only when delta exceeds spread (clean 3→0 turn reduction)', () => {
    // Both sides tight (spread 0). 3-turn drop is clearly above noise.
    const comp = compare(
      makeSummary('m', { passRate: 1, turnsMean: 8, costMean: 0.05, turnsMin: 8, turnsMax: 8 }),
      makeSummary('m', { passRate: 1, turnsMean: 5, costMean: 0.05, turnsMin: 5, turnsMax: 5 }),
    )
    expect(decideVerdict(comp, { minPassRate: 1.0 })).toBe('promote')
  })

  it('inconclusive when missing either side', () => {
    expect(decideVerdict({ baseline: null, treatment: null })).toBe('inconclusive')
  })
})

describe('macro-promotion — roundNum', () => {
  it('rounds to the given decimals', () => {
    expect(roundNum(1.23456, 2)).toBe(1.23)
    expect(roundNum(1.23456, 4)).toBe(1.2346)
    expect(roundNum(0.000123, 5)).toBe(0.00012)
  })

  it('preserves NaN / non-number', () => {
    expect(Number.isNaN(roundNum(NaN, 2))).toBe(true)
  })
})
