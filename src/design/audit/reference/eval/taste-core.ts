/**
 * Taste-eval cores — the PURE bridge from debiased `TasteVerdict`s to the
 * bench-layer taste metrics. Given verdicts (and the corpus ground-truth labels
 * that produced them), these functions report how trustworthy the taste judge is
 * and how the generated directions stack up against the operator reference.
 *
 * Everything here is pure and deterministic: NO IO, NO model, NO bench framework.
 * The win-rate CIs (`wilsonInterval` / `bootstrapDiff95`) are computed at the
 * bench layer from the raw counts these functions return — never re-implemented
 * here — so this module stays a thin, framework-free numeric core.
 *
 * Tie-handling is uniform with the rest of the engine (`assessPageQuality`,
 * `calibrateAgainstVotes`): a tie is never a win and never inflates a
 * denominator, so every rate is a clean decisive proportion with integer
 * `successes`/`n` the bench layer can hand straight to `wilsonInterval`.
 */

import type {
  HumanVote,
  RawVerdict,
  TasteAgreementResult,
  TasteMetrics,
  TastePair,
  TasteVerdict,
} from '../contracts.js'
import { calibrateAgainstVotes } from '../judge/rank.js'

// Re-export the human-vote calibration hook so the taste eval has a single
// import surface. The implementation lives in judge/rank — one solver, no
// duplicated agreement math.
export { calibrateAgainstVotes } from '../judge/rank.js'

const round4 = (n: number): number => Math.round(n * 10000) / 10000

function slotToId(slot: RawVerdict['winnerSlot'], idForSlotA: string, idForSlotB: string): string | 'tie' {
  if (slot === 'A') return idForSlotA
  if (slot === 'B') return idForSlotB
  return 'tie'
}

/**
 * One position-swapped comparison: the two slot-order raw verdicts for a single
 * unordered pair. `ab` presented `aId`→SLOT A and `bId`→SLOT B; `ba` is the swap
 * (`bId`→SLOT A, `aId`→SLOT B). This mirrors the two `judge.compare` calls
 * `judgePair` issues per repetition, so a bench harness can record both raw
 * verdicts and feed them here to diagnose slot bias the reconciled
 * `TasteVerdict` has already absorbed.
 */
export interface SwappedRun {
  aId: string
  bId: string
  ab: RawVerdict
  ba: RawVerdict
}

/** Judge position-bias diagnosis over a set of swapped runs. */
export interface PositionBiasResult {
  /**
   * Fraction of DECISIVE swapped runs (both orders named a winner) whose winning
   * id flipped with the slot — i.e. the judge tracked the physical position, not
   * the design. 0 = no measurable slot bias; 1 = pure slot bias.
   */
  biasRate: number
  /** Number of swapped runs where BOTH orders were decisive (the denominator). */
  n: number
}

/**
 * Judge-vs-label agreement over corpus-vs-corpus taste pairs. Each `TastePair`
 * carries a known-stronger / known-weaker member (the ground-truth label); the
 * judge agrees when its debiased verdict for that pair picks the stronger id.
 * Ties (judge said tie) and pairs the judge never compared are excluded from
 * `n`. Empty → `{ agreementRate: 0, n: 0 }`, never NaN.
 *
 * Reuses `calibrateAgainstVotes`: a corpus label IS exactly a human vote for the
 * stronger id, so the same agreement walk applies — pair lookup is unordered, so
 * a verdict recorded in either slot order resolves correctly.
 */
export function tasteAgreement(pairs: TastePair[], verdicts: TasteVerdict[]): TasteAgreementResult {
  const votes: HumanVote[] = pairs.map((p) => ({ aId: p.strongId, bId: p.weakId, winner: p.strongId }))
  const { agreement, n } = calibrateAgainstVotes(verdicts, votes)
  return { agreementRate: agreement, n }
}

/**
 * Generated-vs-reference metrics: how often a generated direction beats the
 * single operator reference. `winsVsReference` counts the decisive comparisons
 * the generated side won; `comparisons` counts the decisive comparisons that
 * backed it. Ties, self-pairs, and verdicts not involving `referenceId` are
 * excluded from `comparisons`, so the bench layer can form a clean Wilson
 * interval `wilsonInterval(winsVsReference, comparisons)`. `corpusOrderAgreement`
 * is intentionally left undefined here — it is a DIFFERENT verdict set
 * (corpus-vs-corpus); the caller folds it in from `tasteAgreement`. Empty → 0
 * wins / 0 comparisons, never NaN.
 */
export function tasteMetricsFromVerdicts(referenceId: string, verdicts: TasteVerdict[]): TasteMetrics {
  let winsVsReference = 0
  let comparisons = 0
  for (const v of verdicts) {
    if (v.aId === v.bId) continue
    if (v.aId !== referenceId && v.bId !== referenceId) continue
    if (v.winner === 'tie') continue
    comparisons += 1
    if (v.winner !== referenceId) winsVsReference += 1
  }
  return { winsVsReference, comparisons }
}

/**
 * Position-bias rate from swapped runs. A run is DECISIVE when both slot orders
 * named a winner; among decisive runs, the judge is position-biased on that run
 * when the winning id flips with the slot (it picked the same physical slot both
 * times — exactly the `reconcileVerdicts` "position bias → tie" branch, measured
 * here as a rate). Runs where either order tied are excluded from `n`. Empty →
 * `{ biasRate: 0, n: 0 }`, never NaN.
 */
export function positionBiasRate(runs: SwappedRun[]): PositionBiasResult {
  let n = 0
  let biased = 0
  for (const run of runs) {
    const w1 = slotToId(run.ab.winnerSlot, run.aId, run.bId)
    const w2 = slotToId(run.ba.winnerSlot, run.bId, run.aId)
    if (w1 === 'tie' || w2 === 'tie') continue
    n += 1
    if (w1 !== w2) biased += 1
  }
  return { biasRate: n > 0 ? round4(biased / n) : 0, n }
}
