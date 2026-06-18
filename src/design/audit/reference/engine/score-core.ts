/**
 * Scoring core — the SINGLE scoring authority for the reference-grounded engine.
 *
 * Everything the pipeline scores derives from ONE `QualityAssessment` (the
 * absolute leg: the page-under-audit's win-rate vs the retrieved world-class
 * exemplars). This module turns that one assessment into three honest surfaces,
 * eliminating the double-scoring the v1 path risked:
 *
 *  - `deriveHeadlineScore` → the 0-10 headline, monotonic in `overallWinRate`,
 *    capped when deterministic measurements flag blocking issues (you cannot be
 *    world-class with critical a11y/contrast failures).
 *  - `toDimensionScores` → the rich 5-`Dimension` `Record<Dimension, DimensionScore>`
 *    that IS stage-8's `precomputedScores` hook. Each dimension is scored ONLY
 *    from a genuinely judge-resolved per-dimension win-rate; a dimension with no
 *    signal is filled at `confidence:'low'` with an explicit "not assessed"
 *    summary — never the overall number stamped across dimensions.
 *  - `toDesignSystemScore` → the flat 8-axis `DesignSystemScore` back-compat
 *    field, an HONESTLY coarse projection of `overallWinRate` (not a second
 *    per-axis authority).
 *
 * Pure and deterministic: no IO, no LLM, no clock. Notably does NOT borrow
 * `conservativeScore` — there are no per-pass page scores in this mode, so
 * importing it would be scoring fiction.
 */

import type {
  QualityAssessment,
  MeasurementBundle,
  Dimension,
  DimensionScore,
  DesignSystemScore,
} from '../contracts.js'
import { DIMENSIONS } from '../../score-types.js'

// Headline runs on a 0-10 scale; dimension + design-system axes run on the
// 1-10 scale the rest of the audit uses (see evaluate.ts / DimensionScore).
const HEADLINE_MAX = 10
// A page with deterministic blocking issues (critical/serious a11y or contrast
// failures, `MeasurementBundle.hasBlockingIssues`) cannot earn a top headline.
// Mirrors the ethics gate's major-floor cap (6) — a measurement ceiling, not a
// floor in the colloquial sense.
const BLOCKING_ISSUE_HEADLINE_CAP = 6
// Neutral placeholder for a dimension the budget never judged. NOT derived from
// `overallWinRate`; paired with `confidence:'low'` + a full [1,10] range so it
// reads as "unassessed", never as a real per-dimension verdict.
const UNASSESSED_DIMENSION_SCORE = 5
// Per-dimension confidence tiers keyed off how many comparisons backed the
// quality leg. More comparisons ⇒ higher confidence ⇒ a tighter range.
const HIGH_CONFIDENCE_COMPARISONS = 8
const MEDIUM_CONFIDENCE_COMPARISONS = 4

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Map a 0-1 win-rate onto the 1-10 dimension/design-system scale. */
function winRateToScore(winRate: number): number {
  return Math.max(1, Math.min(10, Math.round(clamp01(winRate) * 10)))
}

/**
 * Derive the 0-10 headline from the absolute win-rate, capped when measurements
 * flag blocking issues. Monotonic non-decreasing in `overallWinRate`: a higher
 * win-rate never yields a lower headline.
 */
export function deriveHeadlineScore(
  quality: QualityAssessment,
  measurements: MeasurementBundle,
): number {
  const raw = clamp01(quality.overallWinRate) * HEADLINE_MAX
  const capped = measurements.hasBlockingIssues
    ? Math.min(raw, BLOCKING_ISSUE_HEADLINE_CAP)
    : raw
  return round1(Math.min(HEADLINE_MAX, Math.max(0, capped)))
}

function confidenceFor(comparisons: number): DimensionScore['confidence'] {
  if (comparisons >= HIGH_CONFIDENCE_COMPARISONS) return 'high'
  if (comparisons >= MEDIUM_CONFIDENCE_COMPARISONS) return 'medium'
  return 'low'
}

function rangeSpread(confidence: DimensionScore['confidence']): number {
  if (confidence === 'high') return 1
  if (confidence === 'medium') return 2
  return 3
}

function judgedDimensionScore(
  dim: Dimension,
  winRate: number,
  comparisons: number,
): DimensionScore {
  const score = winRateToScore(winRate)
  const confidence = confidenceFor(comparisons)
  const spread = rangeSpread(confidence)
  return {
    score,
    range: [Math.max(1, score - spread), Math.min(10, score + spread)],
    confidence,
    summary: `${dim}: ${Math.round(clamp01(winRate) * 100)}% win-rate vs world-class exemplars across ${comparisons} pairwise comparison(s).`,
    primaryFindings: [],
  }
}

function unassessedDimensionScore(dim: Dimension): DimensionScore {
  return {
    score: UNASSESSED_DIMENSION_SCORE,
    range: [1, 10],
    confidence: 'low',
    summary: `${dim}: not independently judged — no dimension-scoped comparison ran under this run's judge budget (overall-only leg). Placeholder, not derived from the overall win-rate.`,
    primaryFindings: [],
  }
}

/**
 * Map the per-`Dimension` win-rates onto the rich `Record<Dimension, DimensionScore>`
 * stage-8 consumes as `precomputedScores`. Every one of the 5 dimensions is
 * present. Dimensions with a real per-dimension win-rate are scored from it
 * (win-rate → score, comparison count → range + confidence); dimensions with no
 * win-rate are filled as explicit, low-confidence placeholders so the absence of
 * a dimension-scoped leg is honest rather than fabricated.
 */
export function toDimensionScores(
  quality: QualityAssessment,
): Record<Dimension, DimensionScore> {
  const rates = quality.dimensionWinRates ?? {}
  const out: Partial<Record<Dimension, DimensionScore>> = {}
  for (const dim of DIMENSIONS) {
    const winRate = rates[dim]
    out[dim] =
      winRate === undefined
        ? unassessedDimensionScore(dim)
        : judgedDimensionScore(dim, winRate, quality.comparisons)
  }
  return out as Record<Dimension, DimensionScore>
}

/**
 * Project `overallWinRate` onto the flat 8-axis `DesignSystemScore` back-compat
 * field. Every axis carries the same overall-derived 1-10 number — this is an
 * honest coarse projection, NOT a second per-axis scoring authority (the judge
 * resolves the 5 product dimensions, not these 8 design-system axes).
 */
export function toDesignSystemScore(quality: QualityAssessment): DesignSystemScore {
  const s = winRateToScore(quality.overallWinRate)
  return {
    layout: s,
    typography: s,
    color: s,
    spacing: s,
    components: s,
    interactions: s,
    accessibility: s,
    polish: s,
  }
}
