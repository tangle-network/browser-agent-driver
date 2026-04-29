import { describe, it, expect } from 'vitest'
import { buildAuditResult } from '../src/design/audit/build-result.js'
import type { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'
import type {
  PageAuditResult,
  ComposedRubric,
  MeasurementBundle,
} from '../src/design/audit/types.js'
import type {
  AuditResult,
  Dimension,
  DimensionScore,
  EnsembleClassification,
} from '../src/design/audit/score-types.js'
import { DIMENSIONS } from '../src/design/audit/score-types.js'

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
  // Brain that throws — buildAuditResult should fall back to synthesized
  // scores when given precomputedScores OR when the brain call fails.
  const brain = {
    auditDesign: async () => {
      throw new Error('no brain in tests')
    },
  } as unknown as Brain
  const state = { url: 'x', title: 'x', snapshot: '', screenshot: '' } as PageState
  return { brain, state }
}

describe('buildAuditResult — Layer 1', () => {
  it('produces a complete AuditResult with every required field (precomputed path)', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const result: AuditResult = await buildAuditResult({
      brain,
      state,
      pageRef: 'https://example.com/app',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(7),
      precomputedScores: uniformScores(8, 'high'),
    })

    expect(typeof result.runId).toBe('string')
    expect(result.pageRef).toBe('https://example.com/app')
    expect(result.classification.type).toBe('saas-app')
    expect(result.classification.signalsAgreed).toBe(true)

    for (const dim of DIMENSIONS) {
      expect(result.scores[dim]).toBeDefined()
      expect(result.scores[dim].score).toBe(8)
      expect(result.scores[dim].range[0]).toBeLessThanOrEqual(result.scores[dim].score)
      expect(result.scores[dim].range[1]).toBeGreaterThanOrEqual(result.scores[dim].score)
    }

    expect(result.rollup.score).toBeCloseTo(8, 1)
    expect(result.rollup.confidence).toBe('high')
    expect(result.rollup.rule).toContain('saas-app')

    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
    for (const f of result.findings) {
      expect(typeof f.id).toBe('string')
      expect(f.id.length).toBeGreaterThan(0)
      expect(['product_intent', 'visual_craft', 'trust_clarity', 'workflow', 'content_ia']).toContain(f.dimension)
      expect(['polish', 'job', 'measurement']).toContain(f.kind)
      expect(Array.isArray(f.patches)).toBe(true)
    }

    expect(Array.isArray(result.topFixes)).toBe(true)
    expect(result.topFixes.length).toBeLessThanOrEqual(5)
    for (const fixId of result.topFixes) {
      expect(result.findings.some((f) => f.id === fixId)).toBe(true)
    }

    expect(Array.isArray(result.ethicsViolations)).toBe(true)
    expect(Array.isArray(result.matchedPatterns)).toBe(true)
    expect(result.modality).toBe('html')
    expect(typeof result.evaluatedAt).toBe('string')
    expect(typeof result.promptHash).toBe('string')
    expect(typeof result.rubricHash).toBe('string')
    expect(Array.isArray(result.passes)).toBe(true)
  })

  it('rollup score reflects per-page-type weights (saas-app vs marketing)', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const scores = uniformScores(7, 'high')
    // tilt one dimension low
    scores.product_intent = { score: 3, range: [2, 4], confidence: 'high', summary: '', primaryFindings: [] }

    const saas = await buildAuditResult({
      brain,
      state,
      pageRef: 'x',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(),
      precomputedScores: scores,
    })

    const marketing = await buildAuditResult({
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
    const result = await buildAuditResult({
      brain,
      state,
      pageRef: 'x',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(6),
    })
    // Synthesized fallback: every dim equals v1 score, confidence 'low'.
    expect(result.scores.product_intent.score).toBe(6)
    expect(result.scores.product_intent.confidence).toBe('low')
    expect(result.rollup.confidence).toBe('low')
    expect(result.error).toMatch(/multidim-score-fallback: no brain in tests/)
  })

  it('classification carries ensembleConfidence + signalsAgreed', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const ensemble: EnsembleClassification = {
      ...fakeEnsemble('saas-app'),
      ensembleConfidence: 0.42,
      signalsAgreed: false,
      dissent: [{ source: 'dom-heuristic', type: 'marketing' }],
    }
    const result = await buildAuditResult({
      brain,
      state,
      pageRef: 'x',
      ensemble,
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(),
      precomputedScores: uniformScores(6),
    })
    expect(result.classification.ensembleConfidence).toBe(0.42)
    expect(result.classification.signalsAgreed).toBe(false)
    expect(result.classification.dissent?.length).toBe(1)
  })

  it('Layer 2: keeps a major finding with a valid patch, downgrades a major finding without one', async () => {
    const { brain } = fakeStateWithoutBrain()
    // Snapshot contains the text that one patch's `before` references.
    // The other major finding's patch references text that's NOT in the
    // snapshot, so its patch is invalid and the finding gets downgraded.
    const state: PageState = { url: 'x', title: 'x', snapshot: 'padding: 8px 14px;', screenshot: '' } as PageState
    const v1: PageAuditResult = {
      url: 'https://example.com/',
      score: 5,
      summary: '',
      strengths: [],
      findings: [
        {
          category: 'ux',
          severity: 'major',
          description: 'Hero CTA undersized',
          location: 'hero',
          suggestion: 'enlarge',
          impact: 8, effort: 2, blast: 'section',
          rawPatches: [{
            patchId: 'p-1',
            findingId: 'placeholder',
            scope: 'section',
            target: { scope: 'html', cssSelector: 'section.hero button[type=submit]' },
            diff: { before: 'padding: 8px 14px;', after: 'padding: 12px 20px;' },
            testThatProves: { kind: 'rerun-audit', description: 'Hero CTA size lifts visual_craft.' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'medium',
          }],
        },
        {
          category: 'spacing',
          severity: 'major',
          description: 'Card density too tight',
          location: 'cards',
          suggestion: 'add gap',
          impact: 6, effort: 2, blast: 'component',
          rawPatches: [{
            patchId: 'p-2',
            findingId: 'placeholder',
            scope: 'component',
            target: { scope: 'html', cssSelector: '.card' },
            diff: { before: 'NOT IN SNAPSHOT', after: 'gap: 12px;' },
            testThatProves: { kind: 'rerun-audit', description: 'tighter spacing' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'medium',
          }],
        },
      ],
    }
    const result = await buildAuditResult({
      brain, state, pageRef: 'https://example.com/',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(), measurements: fakeMeasurements(),
      v1Result: v1, precomputedScores: uniformScores(7),
    })
    const findingsBySeverity = (sev: string) => result.findings.filter(f => f.severity === sev)
    expect(findingsBySeverity('major')).toHaveLength(1)
    expect(findingsBySeverity('major')[0].description).toMatch(/CTA undersized/)
    expect(findingsBySeverity('major')[0].patches).toHaveLength(1)
    expect(findingsBySeverity('major')[0].patches[0].patchId).toBe('p-1')
    expect(findingsBySeverity('minor')).toHaveLength(1)
    expect(findingsBySeverity('minor')[0].description).toMatch(/Card density/)
    expect(findingsBySeverity('minor')[0].patches).toHaveLength(0)
  })

  it('fixture-style assertion: low product_intent + saas-app → rollup ≤ 6', async () => {
    const { brain, state } = fakeStateWithoutBrain()
    const scores = uniformScores(5)
    scores.product_intent = { score: 3, range: [2, 4], confidence: 'medium', summary: '', primaryFindings: [] }
    scores.workflow = { score: 4, range: [3, 5], confidence: 'medium', summary: '', primaryFindings: [] }

    const result = await buildAuditResult({
      brain,
      state,
      pageRef: 'fixture://no-primary-action',
      ensemble: fakeEnsemble('saas-app'),
      rubric: fakeRubric(),
      measurements: fakeMeasurements(),
      v1Result: fakeV1(4),
      precomputedScores: scores,
    })
    expect(result.scores.product_intent.score).toBeLessThanOrEqual(4)
    expect(result.rollup.score).toBeLessThanOrEqual(6)
  })
})
