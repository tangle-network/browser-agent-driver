/**
 * Absolute quality assessment — the single honest scoring leg.
 *
 * `assessPageQuality` judges the page-under-audit against the retrieved
 * world-class exemplars with the same position-swapped `judgePair` debias, and
 * reports the page's win-rate. This — NOT the relative direction ranking — is
 * what `score-core` turns into the headline 0-10 and the per-`Dimension` scores.
 *
 * Overall leg: one debiased comparison per exemplar → `overallWinRate`.
 * Optional per-dimension leg (`opts.dimensions`): one dimension-scoped
 * comparison SET per `Dimension`, so each `dimensionWinRates` entry is genuinely
 * judge-resolved (the judge narrows its rubric to that dimension), never the
 * overall number stamped across dims. A dimension with no decisive comparison is
 * OMITTED — callers must not fabricate a per-dim score from `overallWinRate`.
 *
 * Pure¹: the `TasteJudge` is injected, so this unit-tests with a stub judge and
 * no live model. Comparisons run sequentially for deterministic accounting;
 * concurrency/budget is the orchestrator's concern, not this leg's.
 */

import type {
  Dimension,
  JudgeSubject,
  QualityAssessment,
  TasteJudge,
} from '../contracts.js'
import { judgePair } from './pairwise.js'

const round4 = (n: number): number => Math.round(n * 10000) / 10000

/** Neutral rate when no decisive (non-tie) comparison backed a leg. */
const ON_PAR = 0.5

interface WinRate {
  /** Page win-rate over decisive comparisons, or ON_PAR when none were decisive. */
  rate: number
  /** Count of non-tie comparisons. */
  comparisons: number
}

async function pageWinRate(
  judge: TasteJudge,
  page: JudgeSubject,
  exemplars: JudgeSubject[],
  dimension?: Dimension,
): Promise<WinRate> {
  let wins = 0
  let comparisons = 0
  for (const exemplar of exemplars) {
    const verdict = await judgePair(judge, { a: page, b: exemplar, dimension })
    if (verdict.winner === 'tie') continue
    comparisons++
    if (verdict.winner === page.id) wins++
  }
  return { rate: comparisons > 0 ? round4(wins / comparisons) : ON_PAR, comparisons }
}

/**
 * Assess the absolute quality of `page` against `exemplars` → a `win-rate`-keyed
 * `QualityAssessment`.
 */
export async function assessPageQuality(
  judge: TasteJudge,
  page: JudgeSubject,
  exemplars: JudgeSubject[],
  opts: { dimensions?: Dimension[] } = {},
): Promise<QualityAssessment> {
  const overall = await pageWinRate(judge, page, exemplars)

  let dimensionWinRates: Partial<Record<Dimension, number>> | undefined
  const dimensions = opts.dimensions ?? []
  if (dimensions.length > 0 && exemplars.length > 0) {
    const collected: Partial<Record<Dimension, number>> = {}
    for (const dimension of dimensions) {
      const dim = await pageWinRate(judge, page, exemplars, dimension)
      // Omit a dimension with no decisive signal rather than stamp a fake rate.
      if (dim.comparisons > 0) collected[dimension] = dim.rate
    }
    if (Object.keys(collected).length > 0) dimensionWinRates = collected
  }

  return {
    overallWinRate: overall.rate,
    dimensionWinRates,
    comparisons: overall.comparisons,
  }
}
