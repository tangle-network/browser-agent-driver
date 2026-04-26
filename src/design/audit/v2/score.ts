/**
 * Layer 1 multi-dim scoring — prompt builder, parser, and rollup.
 *
 * Pure functions. No I/O, no Brain dependency. The pipeline supplies the
 * inputs (classification, rubric, anchor, measurements) and persists the
 * resulting `Record<Dimension, DimensionScore> + RollupScore`.
 */

import {
  DIMENSIONS,
  type ConfidenceLevel,
  type Dimension,
  type DimensionScore,
  type RollupScore,
} from './types.js'
import type { PageType } from '../types.js'
import { rollupFormula, rollupWeightsFor } from '../rubric/rollup-weights.js'
import type { CalibrationAnchor } from '../rubric/anchor-loader.js'
import { renderAnchor } from '../rubric/anchor-loader.js'

const VALID_CONFIDENCE: readonly ConfidenceLevel[] = ['high', 'medium', 'low'] as const

export interface BuildV2PromptInput {
  pageType: PageType
  rubricBody: string
  anchor?: CalibrationAnchor
  /** Concise text summary of deterministic measurements (axe, contrast). */
  measurementSummary: string
  /** Optional auditor framing override. */
  systemOpener?: string
  /** Page intent line surfaced from classification. */
  intent?: string
}

const DEFAULT_OPENER =
  'You are a principal product-design auditor. Score this page on five universal dimensions independently, with explicit ranges and confidence. The downstream system aggregates these into a page-type-aware rollup.'

/**
 * Build the v2 evaluation prompt. Demands per-dim DimensionScore output with
 * range + confidence. Does NOT request the rollup — the rollup is computed
 * deterministically from the per-dim scores using rollup-weights.
 */
export function buildEvalPromptV2(input: BuildV2PromptInput): string {
  const opener = input.systemOpener ?? DEFAULT_OPENER
  const anchorBlock = input.anchor ? renderAnchor(input.anchor) : ''
  const intentLine = input.intent ? `\nPAGE INTENT (from classifier): ${input.intent}` : ''

  return `${opener}

You are auditing a page that has been pre-classified as type=${input.pageType}. Contrast and accessibility measurements have already been counted deterministically — do NOT re-evaluate them. They will be merged with your output.${intentLine}

DIMENSIONS — score each one 1-10 (integer) with an explicit uncertainty range and confidence:

  product_intent  — Does the page make its audience, purpose, primary action, and product state obvious within 5 seconds? Empty/loading/error states designed?
  visual_craft    — Is the visual system intentional? Typography ramp, spacing rhythm, color tokens, component coherence, polish details. Decorative-but-shallow output is a defect.
  trust_clarity   — Are commitments (money, identity, deploy, share, irreversible actions) accompanied by the right trust details (price, fees, permissions, undo path, provenance)?
  workflow        — Can a user complete the end-to-end job? State transitions, recovery from failure, action hierarchy match the operational verbs of the system.
  content_ia      — Is the copy plain and useful? Are labels and IA tuned to the audience's tasks? Meta-copy that explains the UI is a defect.

DETERMINISTIC MEASUREMENTS (do not duplicate):
${input.measurementSummary}

${anchorBlock ? anchorBlock + '\n\n' : ''}EVALUATION RUBRIC:
${input.rubricBody}

OUTPUT REQUIREMENTS:
- Every dimension MUST have an integer score 1-10.
- Every dimension MUST have a range [low, high] with low <= score <= high. Range width encodes your uncertainty.
- Every dimension MUST have confidence in {"high","medium","low"}.
- Summary is one sentence grounded in observable evidence.
- primaryFindings is a list of finding ids that drive the score (may be empty if you produce no findings).

RESPOND WITH ONLY a JSON object:
{
  "scores": {
    "product_intent": { "score": 6, "range": [5, 7], "confidence": "medium", "summary": "Hero is clear but action hierarchy is diffuse.", "primaryFindings": [] },
    "visual_craft":   { "score": 7, "range": [6, 8], "confidence": "high",   "summary": "Spacing rhythm is intentional but type ramp drifts in cards.", "primaryFindings": [] },
    "trust_clarity":  { "score": 5, "range": [4, 6], "confidence": "medium", "summary": "Fees disclosed but only at the final step.", "primaryFindings": [] },
    "workflow":       { "score": 6, "range": [5, 7], "confidence": "medium", "summary": "Empty state directs the user but error recovery is implicit.", "primaryFindings": [] },
    "content_ia":     { "score": 7, "range": [6, 8], "confidence": "high",   "summary": "Copy is plain and audience-tuned.", "primaryFindings": [] }
  },
  "summary": "One-sentence overall assessment.",
  "strengths": ["..."],
  "findings": []
}

Score 1-10. Most production apps score 5-7. Only world-class deserves 8+. Be honest.`
}

export interface ParsedDimensionScores {
  scores: Record<Dimension, DimensionScore>
  summary: string
  strengths: string[]
}

/**
 * Parse the v2 LLM response. Throws when scores are missing, ranges violate
 * `range[0] <= score <= range[1]`, or score is outside 1..10. The pipeline
 * catches the throw and falls back to v1 mean-of-passes.
 */
export function parseAuditResponseV2(raw: string): ParsedDimensionScores {
  const parsed = extractJsonObject(raw)
  if (!parsed) throw new Error('v2 parser: no JSON object in response')

  const rawScores = (parsed as { scores?: unknown }).scores
  if (!rawScores || typeof rawScores !== 'object') {
    throw new Error('v2 parser: missing scores object')
  }

  const scoreMap = rawScores as Record<string, unknown>
  const out: Record<string, DimensionScore> = {}
  for (const dim of DIMENSIONS) {
    const dimRaw = scoreMap[dim]
    if (!dimRaw || typeof dimRaw !== 'object') {
      throw new Error(`v2 parser: dimension ${dim} missing`)
    }
    out[dim] = parseDimensionScore(dim, dimRaw as Record<string, unknown>)
  }

  return {
    scores: out as Record<Dimension, DimensionScore>,
    summary: typeof (parsed as { summary?: unknown }).summary === 'string' ? (parsed as { summary: string }).summary : '',
    strengths: Array.isArray((parsed as { strengths?: unknown }).strengths)
      ? ((parsed as { strengths: unknown[] }).strengths.filter(
          (s): s is string => typeof s === 'string',
        ))
      : [],
  }
}

function parseDimensionScore(dim: Dimension, raw: Record<string, unknown>): DimensionScore {
  const score = raw.score
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`v2 parser: ${dim}.score must be a number`)
  }
  const integerScore = Math.round(score)
  if (integerScore < 1 || integerScore > 10) {
    throw new Error(`v2 parser: ${dim}.score=${integerScore} outside 1..10`)
  }
  const range = raw.range
  if (!Array.isArray(range) || range.length !== 2 || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    throw new Error(`v2 parser: ${dim}.range must be [number, number]`)
  }
  const [low, high] = range
  if (low > high) {
    throw new Error(`v2 parser: ${dim}.range=[${low},${high}] inverted`)
  }
  if (integerScore < low || integerScore > high) {
    throw new Error(`v2 parser: ${dim}.score=${integerScore} outside range [${low},${high}]`)
  }
  if (low < 1 || high > 10) {
    throw new Error(`v2 parser: ${dim}.range=[${low},${high}] outside 1..10`)
  }
  const confidenceRaw = String(raw.confidence ?? '').toLowerCase()
  const confidence = (VALID_CONFIDENCE as readonly string[]).includes(confidenceRaw)
    ? (confidenceRaw as ConfidenceLevel)
    : 'medium'
  const summary = typeof raw.summary === 'string' ? raw.summary : ''
  const primaryFindings = Array.isArray(raw.primaryFindings)
    ? raw.primaryFindings.filter((s): s is string => typeof s === 'string')
    : []
  return { score: integerScore, range: [low, high], confidence, summary, primaryFindings }
}

/**
 * Compute the rollup from per-dimension scores using per-page-type weights.
 * Conservative confidence rule: rollup confidence = lowest dim confidence.
 */
export function computeRollup(scores: Record<Dimension, DimensionScore>, pageType: PageType): RollupScore {
  const weights = rollupWeightsFor(pageType)
  let weighted = 0
  let lowSum = 0
  let highSum = 0
  for (const dim of DIMENSIONS) {
    const dimScore = scores[dim]
    const w = weights[dim]
    weighted += dimScore.score * w
    lowSum += dimScore.range[0] * w
    highSum += dimScore.range[1] * w
  }
  const score = Math.round(weighted * 10) / 10
  const range: [number, number] = [
    Math.round(lowSum * 10) / 10,
    Math.round(highSum * 10) / 10,
  ]

  const confidences = DIMENSIONS.map((d) => scores[d].confidence)
  const confidence: ConfidenceLevel = confidences.includes('low')
    ? 'low'
    : confidences.includes('medium')
    ? 'medium'
    : 'high'

  return {
    score,
    range,
    confidence,
    rule: rollupFormula(pageType, weights),
    weights,
  }
}

/**
 * Aggregate per-dim scores from N independent passes (mean). Used when the
 * audit runs deep mode and we want one DimensionScore per dimension.
 */
export function mergeDimensionScoresAcrossPasses(
  perPass: Array<Record<Dimension, DimensionScore>>,
): Record<Dimension, DimensionScore> {
  if (perPass.length === 0) {
    throw new Error('mergeDimensionScoresAcrossPasses: empty input')
  }
  if (perPass.length === 1) return perPass[0]!

  const out: Partial<Record<Dimension, DimensionScore>> = {}
  for (const dim of DIMENSIONS) {
    const samples = perPass.map((p) => p[dim])
    const meanScore = samples.reduce((a, s) => a + s.score, 0) / samples.length
    const meanLow = samples.reduce((a, s) => a + s.range[0], 0) / samples.length
    const meanHigh = samples.reduce((a, s) => a + s.range[1], 0) / samples.length
    const conf = samples.map((s) => s.confidence)
    const confidence: ConfidenceLevel = conf.includes('low') ? 'low' : conf.includes('medium') ? 'medium' : 'high'
    const allFindings = samples.flatMap((s) => s.primaryFindings)
    const primaryFindings = Array.from(new Set(allFindings)).slice(0, 3)
    const summary = samples.find((s) => s.summary)?.summary ?? ''
    out[dim] = {
      score: Math.round(meanScore),
      range: [
        Math.max(1, Math.floor(meanLow)),
        Math.min(10, Math.ceil(meanHigh)),
      ],
      confidence,
      summary,
      primaryFindings,
    }
  }
  return out as Record<Dimension, DimensionScore>
}

function extractJsonObject(raw: string): unknown {
  try {
    let text = raw.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}
