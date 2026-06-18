/**
 * Engine budget accounting — the PURE home for all concurrency + judge-cost math.
 *
 * `planJudgeBudget` decides how many pairwise comparisons each leg can afford
 * under an `EngineBudget`, and `mapWithConcurrency` runs independent async work
 * with a bounded in-flight pool. Both are deterministic and IO/LLM-free so the
 * orchestrator and the adapters stay thin — no module re-derives "how many calls
 * can we afford" or hand-rolls a worker pool.
 *
 * Cost model (the single invariant every consumer relies on): one pairwise
 * comparison is judged in BOTH slot orders (A/B then B/A) to debias position, so
 * each comparison costs `2` judge calls per repetition. The total judge calls a
 * plan implies is therefore:
 *
 *     (directionPairs + qualityPairs) × 2 × reps   ≤   budget.maxJudgeCalls
 *
 * `qualityPairs` folds in the per-`Dimension` expansion of the absolute quality
 * leg: judging each of the `k` exemplars across `qualityDimensions` dimensions is
 * `k × qualityDimensions` comparisons (or `k` overall-only comparisons when no
 * dimension budget is affordable). When the full dimension set doesn't fit, the
 * plan drops `qualityDimensions` to 0 — an honest overall-only leg — rather than
 * fabricating per-dimension win-rates the budget never paid for.
 */

import type { EngineBudget } from '../contracts.js'

/** Both slot orders are judged per repetition to neutralise position bias. */
const SLOT_ORDERS_PER_REP = 2

/**
 * A resolved judging plan. Every count is what the engine will actually issue,
 * already bounded by `budget.maxJudgeCalls`.
 */
export interface JudgeBudgetPlan {
  /** Distinct direction-vs-direction pairs to judge (relative ranking leg). */
  directionPairs: number
  /** Page-vs-exemplar comparisons to judge (absolute quality leg). */
  qualityPairs: number
  /** Repetitions per comparison (each rep = both slot orders). */
  reps: number
  /**
   * Number of product dimensions the quality leg can afford to judge per-dim.
   * 0 ⇒ overall-only (no per-`Dimension` win-rates are produced).
   */
  qualityDimensions: number
}

/** Unique unordered pairs over `n` items: C(n, 2). */
function pairCount(n: number): number {
  if (!Number.isFinite(n) || n < 2) return 0
  const k = Math.floor(n)
  return (k * (k - 1)) / 2
}

function nonNegInt(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/**
 * Plan the judge budget for one engine run.
 *
 * Preference order (richest → leanest), stopping at the first plan that fits
 * `budget.maxJudgeCalls`:
 *   1. full per-`Dimension` quality leg at the configured `judgeReps`,
 *   2. overall-only quality leg at `judgeReps`, then walking reps down to 1.
 * Dimensions are dropped before reps because a dimension-scoped leg is opt-in,
 * whereas repetitions buy debiasing on every comparison. If even the leanest
 * plan overflows (a pathologically small `maxJudgeCalls`), the pairs themselves
 * are capped — direction pairs first (winner selection is the core artifact),
 * then the overall quality pairs — so the returned plan never exceeds budget.
 */
export function planJudgeBudget(
  directionCount: number,
  k: number,
  budget: EngineBudget,
  dimensions?: number,
): JudgeBudgetPlan {
  const maxCalls = nonNegInt(budget.maxJudgeCalls)
  const directionPairs = pairCount(directionCount)
  const kk = nonNegInt(k)
  const requestedDims = nonNegInt(dimensions ?? 0)
  const repsFull = Math.max(1, nonNegInt(budget.judgeReps) || 1)

  const qualityPairsFor = (qDims: number): number => (qDims > 0 ? kk * qDims : kk)
  const callsFor = (qDims: number, reps: number): number =>
    (directionPairs + qualityPairsFor(qDims)) * SLOT_ORDERS_PER_REP * reps

  // Candidate plans in strict preference order.
  const candidates: Array<{ qDims: number; reps: number }> = []
  if (requestedDims > 0) candidates.push({ qDims: requestedDims, reps: repsFull })
  for (let reps = repsFull; reps >= 1; reps--) candidates.push({ qDims: 0, reps })

  for (const c of candidates) {
    if (callsFor(c.qDims, c.reps) <= maxCalls) {
      return {
        directionPairs,
        qualityPairs: qualityPairsFor(c.qDims),
        reps: c.reps,
        qualityDimensions: c.qDims,
      }
    }
  }

  // Nothing fits even at reps=1, overall-only: cap the pairs to whatever the
  // budget allows, prioritising the direction (winner-selection) leg.
  const affordablePairs = Math.floor(maxCalls / SLOT_ORDERS_PER_REP)
  const cappedDirectionPairs = Math.min(directionPairs, affordablePairs)
  const cappedQualityPairs = Math.min(kk, affordablePairs - cappedDirectionPairs)
  return {
    directionPairs: cappedDirectionPairs,
    qualityPairs: cappedQualityPairs,
    reps: 1,
    qualityDimensions: 0,
  }
}

/**
 * Map `fn` over `items` with at most `n` calls in flight at once, preserving
 * input order in the output. The first rejection propagates (in-flight siblings
 * are not cancelled, mirroring `Promise.all`). A non-positive / non-finite `n`
 * is treated as 1; concurrency never exceeds `items.length`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  n: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  if (items.length === 0) return results
  const limit = Math.max(1, Math.min(nonNegInt(n) || 1, items.length))
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}
