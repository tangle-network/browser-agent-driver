/**
 * AuditResult builder.
 *
 * Composes the per-dimension scores, ensemble classification, and rollup
 * into the canonical `AuditResult` that downstream consumers (jobs, reports,
 * brand-evolution, orchestrator) read.
 */

import { randomUUID, createHash } from 'node:crypto'
import type { Brain } from '../../brain/index.js'
import type { PageState } from '../../types.js'
import type {
  PageAuditResult,
  PageClassification,
  ComposedRubric,
  MeasurementBundle,
} from './types.js'
import {
  type AuditResult,
  type DesignFinding,
  type Dimension,
  type DimensionScore,
  type EnsembleClassification,
  type RollupScore,
  DIMENSIONS,
} from './score-types.js'
import {
  buildEvalPrompt,
  computeRollup,
  parseAuditResponse,
} from './score.js'
import { renderAnchor, type CalibrationAnchor } from './rubric/anchor-loader.js'
import { parsePatches } from './patches/parse.js'
import { validatePatch } from './patches/validate.js'
import { enforcePatchPolicy } from './patches/severity-enforcement.js'
import { generatePatches } from './patches/generate.js'
import type { AuditOverrides } from './evaluate.js'

export interface BuildAuditResultInput {
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
  /** Evolve-aware overrides. Production runs leave this undefined. */
  overrides?: AuditOverrides
}

/**
 * Produce a complete `AuditResult`. When `precomputedScores` is set we
 * skip the LLM call entirely (used by deterministic tests + the
 * `--audit-passes auto` legacy fallback path).
 */
export async function buildAuditResult(input: BuildAuditResultInput): Promise<AuditResult> {
  const { brain, state, pageRef, ensemble, rubric, measurements, v1Result, anchor, runId } = input

  const measurementSummary = renderMeasurementSummary(measurements)
  const prompt = buildEvalPrompt({
    pageType: ensemble.type,
    rubricBody: rubric.body,
    anchor,
    measurementSummary,
    intent: ensemble.intent,
  })

  let scores: Record<Dimension, DimensionScore>
  let llmTokens = 0
  let scoreFallbackError: string | undefined
  if (input.precomputedScores) {
    scores = input.precomputedScores
  } else {
    try {
      const llm = await brain.auditDesign(state, 'Multi-dimensional audit', [], prompt)
      if (llm.parseError) {
        throw new Error(`brain.auditDesign parse failed: ${llm.parseError}`)
      }
      llmTokens = llm.tokensUsed ?? 0
      const parsed = parseAuditResponse(llm.raw)
      scores = parsed.scores
    } catch (err) {
      // Fall back: synthesize per-dim scores from the v1 result. Conservative —
      // every dim gets the v1 score, range +/- 1, confidence 'low'.
      scoreFallbackError = err instanceof Error ? err.message : String(err)
      scores = synthesizeScoresFromLegacy(v1Result)
    }
  }

  const rollup: RollupScore = computeRollup(scores, ensemble.type)
  // Layer 2 — two-call patch flow. The findings prompt above stayed slim
  // and focused on scoring; now ask the LLM for one patch per major/critical
  // finding (skipped when precomputedScores is set, since tests can supply
  // findings with rawPatches already attached).
  let findings = adaptFindingsLite(v1Result.findings)
  if (!input.precomputedScores) {
    try {
      const generated = await generatePatches({
        brain,
        snapshot: state.snapshot,
        findings: findings,
        config: input.overrides?.patchSynthesis,
      })
      findings = generated.findings
      llmTokens += generated.tokensUsed
    } catch (err) {
      // Patch generator failure is non-fatal — Layer 2 enforcement below will
      // still downgrade major/critical findings that lack a valid patch.
      console.warn(`[audit/patches] generator failed: ${(err as Error).message}`)
    }
  }
  // Now parse rawPatches → typed Patches, validate against the snapshot,
  // and enforce the severity policy (downgrade major/critical without a
  // valid patch). adaptFindingsLite wires the parser; enforceFindingPolicy
  // wires the validator + downgrade rule.
  findings = parseAndAttachPatches(findings)
  findings = enforceFindingPolicy(findings, state.snapshot)
  const topFixes = computeTopFixes(findings).slice(0, 5).map((f) => f.id)

  const promptHash = sha1(prompt)
  const rubricHash = sha1(rubric.body)
  const totalTokens = (v1Result.tokensUsed ?? 0) + llmTokens

  return {
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
    passes: ['multidim'],
    ...(scoreFallbackError || v1Result.error
      ? { error: scoreFallbackError ? `multidim-score-fallback: ${scoreFallbackError}` : v1Result.error }
      : {}),
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

/**
 * Stamp stable ids + dimension + kind onto v1 findings. Patches are parsed
 * separately by parseAndAttachPatches so the patch generator (which runs
 * between adaptFindingsLite and parseAndAttachPatches) can populate
 * `rawPatches` first.
 */
function adaptFindingsLite(v1Findings: PageAuditResult['findings']): DesignFinding[] {
  return v1Findings.map((f, idx) => {
    const id = `finding-${idx + 1}-${sha1(`${f.category}|${f.description}`).slice(0, 8)}`
    const dimension = mapCategoryToDimension(f.category)
    const kind = inferKind(f)
    return {
      ...f,
      id,
      dimension,
      kind,
      patches: [],
    }
  })
}

/**
 * After the patch generator has run, parse each finding's `rawPatches` array
 * into typed Patch objects. The findingId on each parsed patch is overridden
 * with the finding's stable id so it always points at the right place — even
 * if the LLM emitted its own placeholder.
 */
function parseAndAttachPatches(findings: DesignFinding[]): DesignFinding[] {
  return findings.map(f => {
    const rawPatches = (f.rawPatches ?? []) as unknown[]
    if (rawPatches.length === 0) return f
    const parsed = parsePatches(rawPatches.map(p => withFindingId(p, f.id)))
    return { ...f, patches: parsed.patches }
  })
}

/**
 * Inject `findingId` into a raw patch object before parsing, so the finding's
 * stable id always wins over whatever placeholder the LLM emitted.
 */
function withFindingId(raw: unknown, findingId: string): unknown {
  if (raw && typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>), findingId }
  }
  return raw
}

/**
 * Layer 2 enforcement — validate every patch against the page snapshot
 * (drops patches whose `diff.before` isn't actually present), then run the
 * severity policy: major/critical findings without ≥1 valid patch downgrade
 * to minor.
 */
function enforceFindingPolicy(findings: DesignFinding[], snapshot: string): DesignFinding[] {
  // Step 1: per-finding patch validation — keep only valid patches.
  const validated = findings.map(f => {
    const validPatches = (f.patches ?? []).filter(p => validatePatch(p, snapshot).valid)
    return { ...f, patches: validPatches }
  })
  // Step 2: severity downgrade — collect valid patch ids and let the policy
  // decide which findings keep their declared severity.
  const validPatchIds = new Set<string>()
  for (const f of validated) {
    for (const p of f.patches ?? []) validPatchIds.add(p.patchId)
  }
  return enforcePatchPolicy(validated, validPatchIds).findings
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

function synthesizeScoresFromLegacy(v1: PageAuditResult): Record<Dimension, DimensionScore> {
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
      summary: 'Synthesized from v1 score (LLM call unavailable).',
      primaryFindings: [],
    }
  }
  return out as Record<Dimension, DimensionScore>
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

export const BUILD_RESULT_INTERNALS = {
  renderMeasurementSummary,
  adaptFindingsLite,
  parseAndAttachPatches,
  enforceFindingPolicy,
  mapCategoryToDimension,
  computeTopFixes,
  synthesizeScoresFromLegacy,
}

export { renderAnchor }
