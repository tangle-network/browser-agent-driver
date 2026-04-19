/**
 * Pure-logic helpers for the macro promotion flow. Extracted so they can
 * be unit-tested without shelling out to multi-rep runs.
 *
 * Shape of the "summary" objects: the multi-rep-summary.json emitted by
 * scripts/run-multi-rep.mjs. The bits we consume per mode:
 *
 *   { passRate: number,
 *     turnsUsed: {mean, min, max, n},
 *     costUsd:   {mean, min, max, n},
 *     durationMs:{mean, min, max, n},
 *     reps: number }
 */

export function firstMode(summary) {
  if (!summary?.perModeStats) return null
  const keys = Object.keys(summary.perModeStats)
  if (keys.length === 0) return null
  return summary.perModeStats[keys[0]]
}

export function compare(baseline, treatment) {
  const baselineMode = firstMode(baseline)
  const treatmentMode = firstMode(treatment)
  if (!baselineMode || !treatmentMode) {
    return { baseline: baselineMode, treatment: treatmentMode }
  }
  return {
    baseline: baselineMode,
    treatment: treatmentMode,
    deltas: {
      passRate:       roundNum(treatmentMode.passRate - baselineMode.passRate, 4),
      turnsMean:      roundNum(treatmentMode.turnsUsed.mean - baselineMode.turnsUsed.mean, 2),
      costMean:       roundNum(treatmentMode.costUsd.mean - baselineMode.costUsd.mean, 6),
      durationMeanMs: roundNum(treatmentMode.durationMs.mean - baselineMode.durationMs.mean, 0),
    },
  }
}

export function decideVerdict(comparison, successCriteria = {}) {
  if (!comparison.baseline || !comparison.treatment || !comparison.deltas) return 'inconclusive'
  const { passRate, turnsMean, costMean } = comparison.deltas
  const baseline = comparison.baseline
  const treatment = comparison.treatment

  const passRateOK = treatment.passRate >= (successCriteria.minPassRate ?? 0)
  const passRateRegress = passRate < -0.0001
  const turnsCap = successCriteria.maxTurnsMean !== undefined
    ? treatment.turnsUsed.mean <= successCriteria.maxTurnsMean
    : true

  if (!passRateOK || !turnsCap) return 'reject'
  if (passRateRegress) return 'reject'

  // CLAUDE.md §Measurement Rigor rule 2: "(challenger_mean − baseline_mean)
  // less than the worst-case spread of either side = comparable, not an
  // improvement." We approximate that spread from the observed min/max of
  // both sides per-metric. If the candidate delta doesn't exceed the
  // spread, we call it inconclusive — never auto-promote on noise.
  const turnsSpread = Math.max(
    Math.abs(baseline.turnsUsed.max - baseline.turnsUsed.min),
    Math.abs(treatment.turnsUsed.max - treatment.turnsUsed.min),
  )
  const costSpread = Math.max(
    Math.abs(baseline.costUsd.max - baseline.costUsd.min),
    Math.abs(treatment.costUsd.max - treatment.costUsd.min),
  )
  // Require the delta to exceed the spread AND the sample-size-dependent
  // absolute floor. This is a first-order bootstrap proxy; integrating
  // scripts/lib/stats.mjs bootstrapDiff95 is a follow-up.
  const turnsWin = -turnsMean > Math.max(0.5, turnsSpread)
  const costWin = -costMean > Math.max(0.0005, costSpread)
  if (turnsWin || costWin) return 'promote'
  return 'inconclusive'
}

export function roundNum(v, decimals) {
  if (typeof v !== 'number' || Number.isNaN(v)) return v
  const factor = 10 ** decimals
  return Math.round(v * factor) / factor
}
