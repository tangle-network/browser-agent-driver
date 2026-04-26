import { describe, it, expect } from 'vitest'
import { buildAuditResultV2 } from '../src/design/audit/v2/build-result.js'
import type { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'
import type {
  PageAuditResult,
  ComposedRubric,
  MeasurementBundle,
} from '../src/design/audit/types.js'
import type {
  AuditResult_v2,
  Dimension,
  DimensionScore,
  EnsembleClassification,
} from '../src/design/audit/v2/types.js'
import { DIMENSIONS } from '../src/design/audit/v2/types.js'

function fakeMeasurements(): MeasurementBundle {
  return {
    contrast: {
      totalChecked: 50,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 1, aaaPassRate: 1 },
    },
    a11y: {
      ran: true,
      violations: [],
      passes: 30,
    },
    hasBlockingIssues: false,
  }
}

function fakeRubric(): ComposedRubric {
  return {
    fragments: [],
    body: 'TEST RUBRIC BODY',
    calibration: 'Score honestly.',
    dimensions: [],
  }
}

function fakeEnsemble(type: 'saas-app' | 'marketing' = 'saas-app'): EnsembleClassification {
  return {
    type,
    domain: 'unknown',
    framework: null,
    designSystem: 'unknown',
    maturity: 'shipped',
    intent: 'test page',
    confidence: 0.8,
    signals: [
      { source: 'url-pattern', type, confidence: 0.7, rationale: 'fixture' },
      { source: 'dom-heuristic', type, confidence: 0.7, rationale: 'fixture' },
    ],
    signalsAgreed: true,
    ensembleConfidence: 0.8,
    firstPrinciplesMode: false,
  }
}

function fakeV1(score = 7): PageAuditResult {
  return {
    url: 'https://example.com/app',
    score,
    summary: 'fake v1 summary',
    strengths: ['a'],
    findings: [
      {
        category: 'ux',
        severity: 'major',
        description: 'No primary action',
        location: 'main',
        suggestion: 'Add a primary CTA',
        impact: 8,
        effort: 3,
        blast: 'page',
      },
      {
        category: 'spacing',
        severity: 'minor',
        description: 'inconsistent padding',
        location: 'cards',
        suggestion: 'use 8px grid',
        impact: 4,
        effort: 1,
        blast: 'component',
      },
    ],
  }
}

function uniformScores(score: number, conf: 'high' | 'medium' | 'low' = 'medium'): Record<Dimension, DimensionScore> {
  const out: Partial<Record<Dimension, DimensionScore>> = {}
  for (const dim of DIMENSIONS) {
    out[dim] = {
      score,
      range: [Math.max(1, score - 1), Math.min(10, score + 1)],
      confidence: conf,
      summary: '',
      primaryFindings: [],
    }
  }
  return out as Record<Dimension, DimensionScore>
}

function fakeStateWithoutBrain(): { brain: Brain; state: PageState } {
  // Brain that throws — buildAuditResultV2 should fall back to synthesized
  // scores when given precomputedScores OR when the brain call fails.
  const brain = {
    auditDesign: async () => {
      throw new Error('no brain in tests')
    },
  } as unknown as Brain
  const state = { url: 'x', title: 'x', snapshot: '', screenshot: '' } as PageState
  return { brain, state }
}

describe('buildAuditResultV2 — Layer 1', () => {
  it('produces a complete AuditResult_v2 with every required field (precomputed path)', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const v2: AuditResult_v2 = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'https://example.com/app',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(7),
      precomputedScores: uniformScores(8, 'high'),
    })

    expect(v2.schemaVersion).toBe(2)
    expect(typeof v2.runId).toBe('string')
    expect(v2.pageRef).toBe('https://example.com/app')
    expect(v2.classification.type).toBe('saas-app')
    expect(v2.classification.signalsAgreed).toBe(true)

    for (const dim of DIMENSIONS) {
      expect(v2.scores[dim]).toBeDefined()
      expect(v2.scores[dim].score).toBe(8)
      expect(v2.scores[dim].range[0]).toBeLessThanOrEqual(v2.scores[dim].score)
      expect(v2.scores[dim].range[1]).toBeGreaterThanOrEqual(v2.scores[dim].score)
    }

    expect(v2.rollup.score).toBeCloseTo(8, 1)
    expect(v2.rollup.confidence).toBe('high')
    expect(v2.rollup.rule).toContain('saas-app')

    expect(Array.isArray(v2.findings)).toBe(true)
    expect(v2.findings.length).toBeGreaterThan(0)
    for (const f of v2.findings) {
      expect(typeof f.id).toBe('string')
      expect(f.id.length).toBeGreaterThan(0)
      expect(['product_intent', 'visual_craft', 'trust_clarity', 'workflow', 'content_ia']).toContain(f.dimension)
      expect(['polish', 'job', 'measurement']).toContain(f.kind)
      expect(Array.isArray(f.patches)).toBe(true)
    }

    expect(Array.isArray(v2.topFixes)).toBe(true)
    expect(v2.topFixes.length).toBeLessThanOrEqual(5)
    for (const fixId of v2.topFixes) {
      expect(v2.findings.some((f) => f.id === fixId)).toBe(true)
    }

    expect(Array.isArray(v2.ethicsViolations)).toBe(true)
    expect(Array.isArray(v2.matchedPatterns)).toBe(true)
    expect(v2.modality).toBe('html')
    expect(typeof v2.evaluatedAt).toBe('string')
    expect(typeof v2.promptHash).toBe('string')
    expect(typeof v2.rubricHash).toBe('string')
    expect(Array.isArray(v2.passes)).toBe(true)
  })

  it('rollup score reflects per-page-type weights (saas-app vs marketing)', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const scores = uniformScores(7, 'high')
    // tilt one dimension low
    scores.product_intent = { score: 3, range: [2, 4], confidence: 'high', summary: '', primaryFindings: [] }

    const saas = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'x',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(),
      precomputedScores: scores,
    })

    const marketing = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'x',
      ensemble: fakeEnsemble('marketing'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(),
      precomputedScores: scores,
    })

    // saas-app weights product_intent at 0.35 vs marketing 0.30 — saas penalized more.
    expect(saas.rollup.score).toBeLessThan(marketing.rollup.score)
  })

  it('falls back to synthesized scores when LLM call fails', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const v2 = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'x',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(6),
    })
    // Synthesized fallback: every dim equals v1 score, confidence 'low'.
    expect(v2.scores.product_intent.score).toBe(6)
    expect(v2.scores.product_intent.confidence).toBe('low')
    expect(v2.rollup.confidence).toBe('low')
  })

  it('classification carries ensembleConfidence + signalsAgreed', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const ensemble: EnsembleClassification = {
      ...fakeEnsemble('saas-app'),
      ensembleConfidence: 0.42,
      signalsAgreed: false,
      dissent: [{ source: 'dom-heuristic', type: 'marketing' }],
    }
    const v2 = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'x',
      ensemble,
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(),
      precomputedScores: uniformScores(6),
    })
    expect(v2.classification.ensembleConfidence).toBe(0.42)
    expect(v2.classification.signalsAgreed).toBe(false)
    expect(v2.classification.dissent?.length).toBe(1)
  })

  it('fixture-style assertion: low product_intent + saas-app → rollup ≤ 6', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const scores = uniformScores(5)
    scores.product_intent = { score: 3, range: [2, 4], confidence: 'medium', summary: '', primaryFindings: [] }
    scores.workflow = { score: 4, range: [3, 5], confidence: 'medium', summary: '', primaryFindings: [] }

    const v2 = await buildAuditResultV2({
      brain,
      state,
      pageRef: 'fixture://no-primary-action',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(4),
      precomputedScores: scores,
    })
    expect(v2.scores.product_intent.score).toBeLessThanOrEqual(4)
    expect(v2.rollup.score).toBeLessThanOrEqual(6)
  })
})
