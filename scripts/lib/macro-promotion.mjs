/**
 * Pure-logic helpers for the macro promotion flow. Extracted so they can
 * be unit-tested without shelling out to multi-rep runs.
 *
 * Shape of the "summary" objects: the multi-rep-summary.json emitted by
 * scripts/run-multi-rep.mjs. We consume per mode:
 *
 *   { passRate: number,
 *     turnsUsed: {mean, min, max, n},
 *     costUsd:   {mean, min, max, n},
 *     durationMs:{mean, min, max, n},
 *     rawRuns:   [{ rep, passed, durationMs, turnsUsed, tokensUsed,
 *                   estimatedCostUsd }, …],
 *     reps: number }
 *
 * Gen 30: verdict is now driven by bootstrap CI + Cohen's d on the
 * per-rep raw values, not by a first-order spread-dominance heuristic.
 * This is the proper fix for the B-H2 audit finding. We still fall back
 * to the first-order rule when rawRuns is missing (e.g., legacy summaries
 * from before run-multi-rep started emitting rawRuns).
 */
import { bootstrapDiff95, cohenD, classifyEffectSize } from './stats.mjs'

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
  const result = {
    baseline: baselineMode,
    treatment: treatmentMode,
    deltas: {
      passRate:       roundNum(treatmentMode.passRate - baselineMode.passRate, 4),
      turnsMean:      roundNum(treatmentMode.turnsUsed.mean - baselineMode.turnsUsed.mean, 2),
      costMean:       roundNum(treatmentMode.costUsd.mean - baselineMode.costUsd.mean, 6),
      durationMeanMs: roundNum(treatmentMode.durationMs.mean - baselineMode.durationMs.mean, 0),
    },
  }
  // Gen 30: compute bootstrap CIs + Cohen's d on the per-rep raw values
  // when both sides have rawRuns. Absent rawRuns (legacy summaries), the
  // caller falls back to the first-order spread-dominance rule in
  // decideVerdict.
  const baselineRaw = Array.isArray(baselineMode.rawRuns) ? baselineMode.rawRuns : null
  const treatmentRaw = Array.isArray(treatmentMode.rawRuns) ? treatmentMode.rawRuns : null
  if (baselineRaw && treatmentRaw && baselineRaw.length > 0 && treatmentRaw.length > 0) {
    const baselineTurns = baselineRaw.map((r) => Number(r.turnsUsed) || 0)
    const treatmentTurns = treatmentRaw.map((r) => Number(r.turnsUsed) || 0)
    const baselineCost = baselineRaw.map((r) => Number(r.estimatedCostUsd) || 0)
    const treatmentCost = treatmentRaw.map((r) => Number(r.estimatedCostUsd) || 0)
    result.stats = {
      turns: {
        ci95: bootstrapDiff95(treatmentTurns, baselineTurns),
        d: cohenD(treatmentTurns, baselineTurns),
      },
      cost: {
        ci95: bootstrapDiff95(treatmentCost, baselineCost),
        d: cohenD(treatmentCost, baselineCost),
      },
    }
    result.stats.turns.dMagnitude = classifyEffectSize(result.stats.turns.d)
    result.stats.cost.dMagnitude = classifyEffectSize(result.stats.cost.d)
  }
  return result
}

/**
 * Gen 30: Promotion verdict using bootstrap CI + Cohen's d when raw
 * per-rep data is available. Reject/pass-rate gates come first (those
 * are binary outcomes, not continuous), then the efficiency comparison
 * uses the CI's upper bound and the effect size.
 *
 * **Promote** requires BOTH:
 *   - bootstrap CI upper bound < 0 on turns OR cost (we're 95% confident
 *     the treatment uses fewer turns or less cost)
 *   - |Cohen's d| ≥ 0.5 (medium effect or larger — not trivial)
 *
 * **Reject** on any of:
 *   - pass rate below minPassRate
 *   - treatment pass rate strictly below baseline (regression)
 *   - maxTurnsMean criterion violated
 *
 * **Inconclusive** when the data neither promotes nor rejects: the CI
 * straddles zero or the effect size is trivial.
 *
 * When rawRuns is missing from one side (legacy summaries), falls back to
 * the first-order spread-dominance rule from Gen 29.
 */
export function decideVerdict(comparison, successCriteria = {}) {
  if (!comparison.baseline || !comparison.treatment || !comparison.deltas) return 'inconclusive'
  const { passRate } = comparison.deltas
  const treatment = comparison.treatment

  // Gate 1: binary-outcome checks (same as Gen 29)
  const passRateOK = treatment.passRate >= (successCriteria.minPassRate ?? 0)
  const passRateRegress = passRate < -0.0001
  const turnsCap = successCriteria.maxTurnsMean !== undefined
    ? treatment.turnsUsed.mean <= successCriteria.maxTurnsMean
    : true
  if (!passRateOK || !turnsCap) return 'reject'
  if (passRateRegress) return 'reject'

  // Gate 2: efficiency-win check. Prefer the bootstrap path when raw
  // per-rep data is available. Legacy fallback keeps older summaries
  // working; it's strictly less trustworthy but never lies in the
  // direction of false-promotion (spread-dominance is conservative).
  if (comparison.stats) {
    return decideFromBootstrap(comparison.stats)
  }
  return decideFromSpread(comparison)
}

function decideFromBootstrap(stats) {
  // Convention inside stats.mjs: bootstrapDiff95 is (treatment − baseline)
  // so a negative CI upper bound means treatment is confidently lower
  // (for turns/cost, "lower is better"). Cohen's d also follows that
  // convention, so a negative d with medium+ magnitude means the
  // treatment is meaningfully cheaper/faster.
  const turnsImproved = stats.turns.ci95[1] < 0 && Math.abs(stats.turns.d) >= 0.5
  const costImproved = stats.cost.ci95[1] < 0 && Math.abs(stats.cost.d) >= 0.5
  if (turnsImproved || costImproved) return 'promote'
  return 'inconclusive'
}

function decideFromSpread(comparison) {
  // Legacy first-order rule (Gen 29). Kept for backward-compat with
  // summaries that don't carry rawRuns. New summaries should never fall
  // into this branch.
  const { turnsMean, costMean } = comparison.deltas
  const baseline = comparison.baseline
  const treatment = comparison.treatment
  const turnsSpread = Math.max(
    Math.abs(baseline.turnsUsed.max - baseline.turnsUsed.min),
    Math.abs(treatment.turnsUsed.max - treatment.turnsUsed.min),
  )
  const costSpread = Math.max(
    Math.abs(baseline.costUsd.max - baseline.costUsd.min),
    Math.abs(treatment.costUsd.max - treatment.costUsd.min),
  )
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
