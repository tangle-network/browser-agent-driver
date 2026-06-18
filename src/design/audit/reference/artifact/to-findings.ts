/**
 * Artifact → existing-pipeline compatibility layer. PURE: no IO, no LLM.
 *
 * Two responsibilities, both expressed by REUSING the v1 audit helpers rather
 * than re-implementing them — this is what lets the reference-grounded engine
 * return through the unchanged `PageAuditResult` contract that stages 7-9 expect:
 *
 *  1. `directionToFindings` projects the winning `RedesignDirection` + the
 *     DNA-altitude `DnaDelta` onto the CLOSED `DesignFinding` enum as `minor`
 *     recommendations, then MERGES the deterministic `measurementsToFindings`
 *     ground truth (contrast + axe) and ROI-sorts the union via `annotateRoi` /
 *     `topByRoi`. Directional items are always `minor`, so the v1
 *     major/critical-must-carry-a-patch downgrade rule can never corrupt them;
 *     `contrast` / `accessibility` findings come ONLY from measurements — the
 *     generator is never allowed to invent them.
 *  2. `toReferencePageAuditResult` maps a finished `RedesignRunResult` onto the
 *     `PageAuditResult` shape. It NEVER re-scores: the reported page `score` IS
 *     the engine's `headlineScore` — the single scoring authority (`score-core`
 *     off one `QualityAssessment`, already measurement-capped by
 *     `deriveHeadlineScore`). It does NOT borrow `conservativeScore`: there are no
 *     per-pass page scores in this mode, and folding the per-`Dimension` scores in
 *     would let an UNASSESSED placeholder (the default-budget fill, score 5 /
 *     confidence 'low') drag a genuine headline down to ~5 — the scoring fiction
 *     `score-core` was built to avoid. The rich per-dimension surface flows to
 *     stage 8 as `precomputedScores`, never into this headline.
 */

import type {
  RedesignDirection,
  DnaDelta,
  MeasurementBundle,
  DesignFinding,
  RedesignRunResult,
  PageAuditResult,
  Dimension,
  DimensionScore,
} from '../contracts.js'
import { measurementsToFindings } from '../../evaluate.js'
import { annotateRoi, topByRoi } from '../../roi.js'
import { clipToWord } from './text.js'

// Directional recommendations are advisory prose; bound them so an injected
// rationale can never blow up a finding into a wall of text.
const MAX_DIRECTIONAL_CHARS = 240
const MAX_SUMMARY_CHARS = 400
// Cap copy revisions surfaced as findings so a chatty generator can't flood the
// list; the full set always lives in the rich artifact.
const MAX_COPY_FINDINGS = 6
// A dimension at or above this 1-10 score reads as a genuine strength.
const STRENGTH_THRESHOLD = 7

const DIM_LABEL: Record<Dimension, string> = {
  product_intent: 'Product intent',
  visual_craft: 'Visual craft',
  trust_clarity: 'Trust & clarity',
  workflow: 'Workflow',
  content_ia: 'Content & IA',
}

function clip(s: string, max = MAX_DIRECTIONAL_CHARS): string {
  const t = s.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function directionalFinding(over: {
  category: DesignFinding['category']
  description: string
  location: string
  suggestion: string
  impact: number
  effort: number
  blast: NonNullable<DesignFinding['blast']>
}): DesignFinding {
  return {
    category: over.category,
    severity: 'minor',
    description: clip(over.description),
    location: over.location,
    suggestion: clip(over.suggestion),
    impact: over.impact,
    effort: over.effort,
    blast: over.blast,
  }
}

/**
 * Project the winning direction + DNA gap onto `minor` `DesignFinding`s, merge
 * the deterministic measurement findings, and return the ROI-sorted union.
 *
 * The directional categories are restricted to `typography` / `spacing` /
 * `layout` / `ux` — `contrast` and `accessibility` are reserved for
 * `measurementsToFindings` so a generated recommendation can never masquerade as
 * a measured a11y/contrast fact.
 */
export function directionToFindings(
  winner: RedesignDirection,
  gap: DnaDelta,
  measurements: MeasurementBundle,
): DesignFinding[] {
  const directional: DesignFinding[] = []

  // ── Type system ──────────────────────────────────────────────────────────
  const t = winner.typeSystem
  const ratioStr = t.ratio ? `, modular ratio ~${t.ratio}×` : ''
  const families = t.families.join(', ') || 'a single family'
  const scale = t.scalePx.join('/') || 'a defined scale'
  directional.push(
    directionalFinding({
      category: 'typography',
      description: `Adopt the "${winner.name}" type system — families ${families}, scale ${scale}px${ratioStr}. ${t.rationale}`,
      location: 'page typography',
      suggestion: `Apply the proposed type scale and families consistently across headings and body. ${t.rationale}`,
      impact: 5,
      effort: 4,
      blast: 'system',
    }),
  )

  // ── Colour system (no `color` enum member → `ux`; `contrast` stays measured) ─
  const c = winner.colorSystem
  const accent = c.accent ? ` accent ${c.accent},` : ''
  const neutrals = c.neutrals.join(' ') || 'a neutral ramp'
  directional.push(
    directionalFinding({
      category: 'ux',
      description: `Restyle to the "${winner.name}" colour system — primary ${c.primary},${accent} background ${c.background}, neutrals ${neutrals}. ${c.rationale}`,
      location: 'page colour system',
      suggestion: `Map the proposed palette onto your colour tokens. ${c.rationale}`,
      impact: 5,
      effort: 4,
      blast: 'system',
    }),
  )

  // ── Layout / hierarchy ───────────────────────────────────────────────────
  if (winner.hierarchy.length > 0 || winner.asciiLayout.trim()) {
    const order = winner.hierarchy.length ? winner.hierarchy.join(' → ') : 'the proposed structure'
    directional.push(
      directionalFinding({
        category: 'layout',
        description: `Restructure toward the "${winner.name}" layout: ${order}. ${winner.rationale}`,
        location: 'page layout',
        suggestion: `Reflow the page to the proposed information hierarchy: ${order}.`,
        impact: 5,
        effort: 6,
        blast: 'page',
      }),
    )
  }

  // ── Spacing rhythm (only when the gap shows a real rhythm change) ──────────
  if (gap.spacing.densityChanged || gap.spacing.baseUnitFrom !== gap.spacing.baseUnitTo) {
    // Only describe a base-unit re-base when the unit actually moved. With an
    // unchanged base unit the gate fired purely on density, so a "from Xpx to Xpx"
    // clause would be a no-op lie — describe the real (density) delta instead.
    const baseChanged = gap.spacing.baseUnitFrom !== gap.spacing.baseUnitTo
    let description: string
    let suggestion: string
    if (baseChanged) {
      const from = gap.spacing.baseUnitFrom ?? 'none'
      const to = gap.spacing.baseUnitTo ?? 'none'
      description = `Re-base the spacing rhythm from ${from}px to ${to}px${gap.spacing.densityChanged ? ' and rebalance visual density' : ''}. ${gap.summary}`
      suggestion = `Snap padding and margins to a ${to}px grid for a consistent rhythm.`
    } else {
      description = `Rebalance the visual density of the spacing rhythm. ${gap.summary}`
      suggestion = 'Rework padding and margins to rebalance density while keeping the existing base unit.'
    }
    directional.push(
      directionalFinding({
        category: 'spacing',
        description,
        location: 'page spacing',
        suggestion,
        impact: 4,
        effort: 3,
        blast: 'system',
      }),
    )
  }

  // ── Motion (only when the direction actually proposes motion) ─────────────
  const m = winner.motionSpec
  if (m.cues.length > 0 || m.durationsMs.length > 0) {
    const cues = m.cues.join('; ') || 'key transitions'
    const durations = m.durationsMs.join('/') || 'default'
    directional.push(
      directionalFinding({
        category: 'ux',
        description: `Add motion per the "${winner.name}" direction — ${cues} (${durations}ms).`,
        location: 'page motion',
        suggestion: `Apply the proposed motion cues: ${cues}.`,
        impact: 3,
        effort: 4,
        blast: 'page',
      }),
    )
  }

  // ── Copy revisions ────────────────────────────────────────────────────────
  // Drop no-op revisions (before === after after trim) BEFORE slicing so the
  // suppressed rows never consume the MAX_COPY_FINDINGS budget. Genuine adds
  // (before undefined) always survive.
  const copyRevisions = winner.copy.filter(
    (rev) => rev.before === undefined || rev.before.trim() !== rev.after.trim(),
  )
  for (const rev of copyRevisions.slice(0, MAX_COPY_FINDINGS)) {
    directional.push(
      directionalFinding({
        category: 'ux',
        description: rev.before
          ? `Revise copy at ${rev.location}: "${rev.before}" → "${rev.after}".`
          : `Add copy at ${rev.location}: "${rev.after}".`,
        location: rev.location,
        suggestion: `Use the revised copy: "${rev.after}".`,
        impact: 4,
        effort: 2,
        blast: 'page',
      }),
    )
  }

  // Merge deterministic ground truth, then ROI-annotate + sort the union. Reuse
  // — never reimplement — the v1 measurement→finding and ROI helpers.
  const all = [...directional, ...measurementsToFindings(measurements)]
  annotateRoi(all)
  return topByRoi(all, all.length)
}

/**
 * Map a finished engine run onto the v1 `PageAuditResult` so the reference mode
 * flows through stages 7-9 unchanged. Pure: it shapes already-computed values
 * and never issues a new scoring pass.
 *
 * `score` IS `result.headlineScore` — the single scoring authority. The headline
 * is monotonic in the page's win-rate vs world-class exemplars and already capped
 * by `deriveHeadlineScore` when measurements flag blocking issues. The per-
 * `Dimension` scores are NOT folded in here: under the default judge budget they
 * are UNASSESSED placeholders (`score-core`'s confidence-'low' fill), and
 * averaging those into the reported number would crush a genuine headline toward
 * 5. The rich dimension surface is consumed by stage 8 as `precomputedScores`
 * instead. `findings` carries the already ROI-sorted set from the core.
 */
export function toReferencePageAuditResult(result: RedesignRunResult): PageAuditResult {
  const winner = result.artifact.directions[0]

  return {
    url: result.artifact.url,
    score: result.headlineScore,
    summary: buildSummary(result, winner),
    strengths: buildStrengths(result),
    findings: result.findings,
    classification: result.classification,
    measurements: result.measurements,
    designSystemScore: result.designSystemScore,
    tokensUsed: result.tokensUsed,
  }
}

function buildSummary(result: RedesignRunResult, winner: RedesignDirection | undefined): string {
  const wr = Math.round(result.quality.overallWinRate * 100)
  const head = winner
    ? `Reference-grounded redesign — winner "${winner.name}". ${winner.rationale}`
    : 'Reference-grounded redesign produced no ranked direction.'
  // Word-aware truncation: the summary must end on a clean word boundary, never
  // mid-word ("…pairwise compa…"). The hard `clip` stays on the directional
  // finding bodies whose snapshot text must not shift.
  return clipToWord(
    `${head} Page wins ${wr}% of ${result.quality.comparisons} pairwise comparisons against world-class exemplars.`,
    MAX_SUMMARY_CHARS,
  )
}

/**
 * Render one judged dimension as a strength line. `score-core` prefixes its
 * summary with the raw dimension key (`product_intent: …`); strip that so the
 * human label isn't doubled (`Product intent: product_intent: …`).
 */
function strengthLine(dim: Dimension, s: DimensionScore): string {
  const prefix = `${dim}:`
  const body = (s.summary.startsWith(prefix) ? s.summary.slice(prefix.length) : s.summary).trim()
  return `${DIM_LABEL[dim]}: ${body}`
}

function buildStrengths(result: RedesignRunResult): string[] {
  // Only genuinely judge-resolved dimensions can be a strength. A dimension is
  // judge-resolved iff it carries a real per-dimension win-rate; the rest are
  // `score-core` placeholders (default-budget fill) and must never be promoted.
  const judged = result.quality.dimensionWinRates ?? {}
  const entries = (Object.entries(result.dimensionScores) as [Dimension, DimensionScore][]).filter(
    ([dim]) => judged[dim] !== undefined,
  )
  if (entries.length === 0) {
    // No dimension was independently judged under this run's budget. Say so rather
    // than promoting an UNASSESSED placeholder as a strength.
    return ['No dimension was independently judged under this run’s budget — see the headline win-rate and findings.']
  }

  // A genuine strength must actually beat world-class exemplars at least sometimes
  // (win-rate > 0) AND clear the score floor. A 0%-win-rate dimension is the page's
  // WEAKEST axis — it can never be a strength, regardless of its placeholder score.
  const strong = entries
    .filter(([dim, s]) => (judged[dim] ?? 0) > 0 && s.score >= STRENGTH_THRESHOLD)
    .sort((a, b) => b[1].score - a[1].score)
    .map(([dim, s]) => strengthLine(dim, s))
  if (strong.length > 0) return strong

  // Nothing clears the strength bar — surface the strongest dimension that at
  // least wins SOME comparisons, honestly labelled.
  const contenders = entries
    .filter(([dim]) => (judged[dim] ?? 0) > 0)
    .sort((a, b) => b[1].score - a[1].score)
  if (contenders.length > 0) {
    const [dim, s] = contenders[0]
    return [`Strongest area — ${strengthLine(dim, s)}`]
  }

  // Every judged dimension lost every comparison (0% win-rate). Don't invent a
  // strength out of the page's weakest axes.
  return ['No dimension stood out against world-class exemplars — every judged dimension lost its pairwise comparisons.']
}
