/**
 * v2 AuditResult builder.
 *
 * Wraps the existing v1 PageAuditResult with multi-dim scoring + ensemble
 * classification + rollup. Layer 1 emits BOTH schemas in `report.json` so
 * downstream consumers can migrate at their own pace (one-release deprecation
 * window per the RFC).
 */

import { randomUUID, createHash } from 'node:crypto'
import type { Brain } from '../../../brain/index.js'
import type { PageState } from '../../../types.js'
import type {
  PageAuditResult,
  PageClassification,
  ComposedRubric,
  MeasurementBundle,
} from '../types.js'
import {
  type AuditResult_v2,
  type DesignFinding,
  type Dimension,
  type DimensionScore,
  type EnsembleClassification,
  type RollupScore,
  DIMENSIONS,
} from './types.js'
import {
  buildEvalPromptV2,
  computeRollup,
  parseAuditResponseV2,
} from './score.js'
import { renderAnchor, type CalibrationAnchor } from '../rubric/anchor-loader.js'

export interface BuildV2ResultInput {
  brain: Brain
  state: PageState
  pageRef: string
  ensemble: EnsembleClassification
  rubric: ComposedRubric
  measurements: MeasurementBundle
  v1Result: PageAuditResult
  anchor?: CalibrationAnchor
  /** Reuse the pipeline runId so envelopes correlate. */
  runId?: string
  /** Optional override (e.g. test fixtures). When set, skip the LLM call. */
  precomputedScores?: Record<Dimension, DimensionScore>
}

/**
 * Produce a complete `AuditResult_v2`. When `precomputedScores` is set we
 * skip the v2 LLM call entirely (used by deterministic tests + the
 * `--audit-passes auto` legacy fallback path).
 */
export async function buildAuditResultV2(input: BuildV2ResultInput): Promise<AuditResult_v2> {
  const { brain, state, pageRef, ensemble, rubric, measurements, v1Result, anchor, runId } = input

  const measurementSummary = renderMeasurementSummary(measurements)
  const prompt = buildEvalPromptV2({
    pageType: ensemble.type,
    rubricBody: rubric.body,
    anchor,
    measurementSummary,
    intent: ensemble.intent,
  })

  let scores: Record<Dimension, DimensionScore>
  let llmTokens = 0
  if (input.precomputedScores) {
    scores = input.precomputedScores
  } else {
    try {
      const llm = await brain.auditDesign(state, 'Multi-dimensional audit (v2)', [], prompt)
      llmTokens = llm.tokensUsed ?? 0
      const parsed = parseAuditResponseV2(llm.raw)
      scores = parsed.scores
    } catch {
      // Fall back: synthesize per-dim scores from the v1 result. Conservative —
      // every dim gets the v1 score, range +/- 1, confidence 'low'.
      scores = synthesizeScoresFromV1(v1Result)
    }
  }

  const rollup: RollupScore = computeRollup(scores, ensemble.type)
  const findings = adaptFindings(v1Result.findings)
  const topFixes = computeTopFixes(findings).slice(0, 5).map((f) => f.id)

  const promptHash = sha1(prompt)
  const rubricHash = sha1(rubric.body)
  const totalTokens = (v1Result.tokensUsed ?? 0) + llmTokens

  return {
    schemaVersion: 2,
    runId: runId ?? randomUUID(),
    pageRef,
    classification: ensemble,
    scores,
    rollup,
    findings,
    topFixes,
    measurements,
    ethicsViolations: [],
    matchedPatterns: [],
    modality: 'html',
    evaluatedAt: new Date().toISOString(),
    promptHash,
    rubricHash,
    tokensUsed: totalTokens > 0 ? totalTokens : undefined,
    passes: ['v2-multidim'],
    ...(v1Result.error ? { error: v1Result.error } : {}),
  }
}

function renderMeasurementSummary(measurements: MeasurementBundle): string {
  const aaFails = measurements.contrast.aaFailures.length
  const a11y = measurements.a11y.violations.length
  return [
    `contrast AA failures: ${aaFails} of ${measurements.contrast.totalChecked} text elements`,
    `axe violations: ${a11y}${a11y > 0 ? ` (top: ${measurements.a11y.violations.slice(0, 3).map((v) => `${v.id}/${v.impact}`).join(', ')})` : ''}`,
  ].join('\n')
}

function adaptFindings(v1Findings: PageAuditResult['findings']): DesignFinding[] {
  return v1Findings.map((f, idx) => {
    const id = `finding-${idx + 1}-${sha1(`${f.category}|${f.description}`).slice(0, 8)}`
    const dimension = mapCategoryToDimension(f.category)
    const kind = inferKind(f)
    return {
      ...f,
      id,
      dimension,
      kind,
      // Layer 2 supplies real Patches; Layer 1 emits an empty array so the
      // schema is satisfied without fabricating diffs.
      patches: [],
    }
  })
}

function mapCategoryToDimension(category: string): Dimension {
  switch (category) {
    case 'visual-bug':
    case 'spacing':
    case 'typography':
    case 'alignment':
    case 'layout':
      return 'visual_craft'
    case 'contrast':
    case 'accessibility':
      return 'visual_craft'
    case 'ux':
    default:
      return 'product_intent'
  }
}

function inferKind(f: PageAuditResult['findings'][number]): DesignFinding['kind'] {
  if (f.category === 'contrast' || f.category === 'accessibility') return 'measurement'
  if (f.category === 'ux') return 'job'
  return 'polish'
}

function computeTopFixes(findings: DesignFinding[]): DesignFinding[] {
  return [...findings].sort((a, b) => {
    const aScore = (a.impact ?? 0) * blastWeight(a.blast)
    const bScore = (b.impact ?? 0) * blastWeight(b.blast)
    return bScore - aScore
  })
}

function blastWeight(blast: PageAuditResult['findings'][number]['blast']): number {
  switch (blast) {
    case 'system': return 4
    case 'component': return 3
    case 'section': return 2
    default: return 1
  }
}

function synthesizeScoresFromV1(v1: PageAuditResult): Record<Dimension, DimensionScore> {
  const fallback = Math.max(1, Math.min(10, Math.round(v1.score)))
  const out: Partial<Record<Dimension, DimensionScore>> = {}
  for (const dim of DIMENSIONS) {
    out[dim] = {
      score: fallback,
      range: [
        Math.max(1, fallback - 1),
        Math.min(10, fallback + 1),
      ],
      confidence: 'low',
      summary: 'Synthesized from v1 score (v2 LLM call unavailable).',
      primaryFindings: [],
    }
  }
  return out as Record<Dimension, DimensionScore>
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

export const V2_INTERNALS = {
  renderMeasurementSummary,
  adaptFindings,
  mapCategoryToDimension,
  computeTopFixes,
  synthesizeScoresFromV1,
}

export { renderAnchor }
