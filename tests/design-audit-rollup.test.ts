import { describe, it, expect } from 'vitest'
import {
  ROLLUP_WEIGHTS,
  rollupWeightsFor,
  rollupFormula,
} from '../src/design/audit/rubric/rollup-weights.js'
import {
  computeRollup,
  mergeDimensionScoresAcrossPasses,
  parseAuditResponseV2,
} from '../src/design/audit/v2/score.js'
import { DIMENSIONS, type Dimension, type DimensionScore } from '../src/design/audit/v2/types.js'

function dimScore(score: number, range: [number, number] = [score - 1, score + 1], conf: 'high' | 'medium' | 'low' = 'medium'): DimensionScore {
  return {
    score,
    range: [Math.max(1, range[0]), Math.min(10, range[1])],
    confidence: conf,
    summary: '',
    primaryFindings: [],
  }
}

function uniformScores(score: number, conf: 'high' | 'medium' | 'low' = 'medium'): Record<Dimension, DimensionScore> {
  const out: Partial<Record<Dimension, DimensionScore>> = {}
  for (const dim of DIMENSIONS) out[dim] = dimScore(score, [Math.max(1, score - 1), Math.min(10, score + 1)], conf)
  return out as Record<Dimension, DimensionScore>
}

describe('rollup weights — Layer 1', () => {
  it('every page-type weight set sums to 1.0 within 1e-6', () => {
    for (const [type, weights] of Object.entries(ROLLUP_WEIGHTS)) {
      const sum = Object.values(weights).reduce((a, n) => a + n, 0)
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6)
      // every dimension must be present
      for (const dim of DIMENSIONS) {
        expect(typeof weights[dim]).toBe('number')
      }
    }
  })

  it('exposes weights for every PageType plus default + unknown', () => {
    const expected = ['marketing', 'saas-app', 'dashboard', 'docs', 'ecommerce', 'social', 'tool', 'blog', 'utility', 'unknown', 'default']
    for (const t of expected) {
      expect(ROLLUP_WEIGHTS[t as keyof typeof ROLLUP_WEIGHTS]).toBeDefined()
    }
  })

  it('saas-app weights emphasize product_intent + workflow over visual_craft', () => {
    const w = ROLLUP_WEIGHTS['saas-app']
    expect(w.product_intent).toBeGreaterThan(w.visual_craft)
    expect(w.workflow).toBeGreaterThan(w.visual_craft)
  })

  it('marketing weights emphasize visual_craft + content_ia + product_intent', () => {
    const w = ROLLUP_WEIGHTS.marketing
    expect(w.visual_craft).toBeGreaterThanOrEqual(0.25)
    expect(w.content_ia).toBeGreaterThanOrEqual(0.2)
    expect(w.product_intent).toBeGreaterThanOrEqual(0.2)
  })

  it('docs weights emphasize content_ia ≥ 0.4', () => {
    expect(ROLLUP_WEIGHTS.docs.content_ia).toBeGreaterThanOrEqual(0.4)
  })

  it('ecommerce weights emphasize trust_clarity', () => {
    expect(ROLLUP_WEIGHTS.ecommerce.trust_clarity).toBeGreaterThanOrEqual(0.3)
  })

  it('rollupWeightsFor falls back to default for unknown page type', () => {
    const w = rollupWeightsFor(undefined)
    const sum = Object.values(w).reduce((a, n) => a + n, 0)
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6)
  })

  it('rollupFormula renders a deterministic readable formula', () => {
    const formula = rollupFormula('saas-app', ROLLUP_WEIGHTS['saas-app'])
    expect(formula).toContain('saas-app:')
    expect(formula).toContain('product_intent*0.35')
    expect(formula).toContain('workflow*0.30')
  })
})

describe('computeRollup — Layer 1', () => {
  it('uniform 7s on saas-app rolls up to exactly 7', () => {
    const r = computeRollup(uniformScores(7), 'saas-app')
    expect(r.score).toBeCloseTo(7, 6)
    expect(r.range[0]).toBeCloseTo(6, 6)
    expect(r.range[1]).toBeCloseTo(8, 6)
    expect(r.confidence).toBe('medium')
    expect(r.rule).toContain('saas-app')
  })

  it('saas-app rollup weights product_intent more heavily than docs', () => {
    const scores: Record<Dimension, DimensionScore> = {
      product_intent: dimScore(9),
      workflow: dimScore(5),
      visual_craft: dimScore(5),
      trust_clarity: dimScore(5),
      content_ia: dimScore(5),
    }
    const saas = computeRollup(scores, 'saas-app')
    const docs = computeRollup(scores, 'docs')
    expect(saas.score).toBeGreaterThan(docs.score)
  })

  it('confidence is conservative: any low → low rollup', () => {
    const scores = uniformScores(7, 'high')
    scores.workflow = dimScore(7, [6, 8], 'low')
    const r = computeRollup(scores, 'saas-app')
    expect(r.confidence).toBe('low')
  })

  it('confidence is medium when no low + at least one medium', () => {
    const scores = uniformScores(8, 'high')
    scores.product_intent = dimScore(8, [7, 9], 'medium')
    const r = computeRollup(scores, 'marketing')
    expect(r.confidence).toBe('medium')
  })

  it('confidence is high when every dim is high', () => {
    const r = computeRollup(uniformScores(9, 'high'), 'saas-app')
    expect(r.confidence).toBe('high')
  })

  it('weighted-mean math: linear scoring 4 vs 9 with saas-app weights', () => {
    const scores: Record<Dimension, DimensionScore> = {
      product_intent: dimScore(4),
      workflow: dimScore(4),
      visual_craft: dimScore(9),
      trust_clarity: dimScore(9),
      content_ia: dimScore(9),
    }
    const r = computeRollup(scores, 'saas-app')
    // saas-app: 0.35*4 + 0.30*4 + 0.15*9 + 0.10*9 + 0.10*9 = 1.4 + 1.2 + 1.35 + 0.9 + 0.9 = 5.75
    expect(r.score).toBeCloseTo(5.75, 1)
  })
})

describe('mergeDimensionScoresAcrossPasses — Layer 1', () => {
  it('returns identity for a single pass', () => {
    const s = uniformScores(7)
    const merged = mergeDimensionScoresAcrossPasses([s])
    expect(merged.product_intent.score).toBe(7)
  })

  it('averages scores across multiple passes', () => {
    const s1 = uniformScores(6)
    const s2 = uniformScores(8)
    const merged = mergeDimensionScoresAcrossPasses([s1, s2])
    expect(merged.product_intent.score).toBe(7)
  })

  it('takes the floor confidence across passes', () => {
    const s1 = uniformScores(7, 'high')
    const s2 = uniformScores(7, 'low')
    const merged = mergeDimensionScoresAcrossPasses([s1, s2])
    expect(merged.product_intent.confidence).toBe('low')
  })

  it('throws on empty input', () => {
    expect(() => mergeDimensionScoresAcrossPasses([])).toThrow(/empty/)
  })
})

describe('parseAuditResponseV2 — Layer 1', () => {
  const validRaw = JSON.stringify({
    scores: {
      product_intent: { score: 6, range: [5, 7], confidence: 'medium', summary: 'ok', primaryFindings: [] },
      visual_craft: { score: 7, range: [6, 8], confidence: 'high', summary: 'ok', primaryFindings: [] },
      trust_clarity: { score: 5, range: [4, 6], confidence: 'medium', summary: 'ok', primaryFindings: [] },
      workflow: { score: 6, range: [5, 7], confidence: 'medium', summary: 'ok', primaryFindings: [] },
      content_ia: { score: 7, range: [6, 8], confidence: 'high', summary: 'ok', primaryFindings: [] },
    },
    summary: 'overall',
    strengths: ['a', 'b'],
  })

  it('parses a well-formed v2 response with every dimension', () => {
    const out = parseAuditResponseV2(validRaw)
    expect(out.scores.product_intent.score).toBe(6)
    expect(out.scores.visual_craft.confidence).toBe('high')
    expect(out.summary).toBe('overall')
    expect(out.strengths).toEqual(['a', 'b'])
  })

  it('parses fenced JSON', () => {
    const fenced = '```json\n' + validRaw + '\n```'
    const out = parseAuditResponseV2(fenced)
    expect(out.scores.product_intent.score).toBe(6)
  })

  it('rejects scores outside [range[0], range[1]]', () => {
    const bad = JSON.stringify({
      scores: {
        product_intent: { score: 3, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        visual_craft: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
        trust_clarity: { score: 5, range: [4, 6], confidence: 'medium', summary: '', primaryFindings: [] },
        workflow: { score: 6, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        content_ia: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
      },
    })
    expect(() => parseAuditResponseV2(bad)).toThrow(/outside range/)
  })

  it('rejects scores outside 1..10', () => {
    const bad = JSON.stringify({
      scores: {
        product_intent: { score: 11, range: [10, 12], confidence: 'medium', summary: '', primaryFindings: [] },
        visual_craft: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
        trust_clarity: { score: 5, range: [4, 6], confidence: 'medium', summary: '', primaryFindings: [] },
        workflow: { score: 6, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        content_ia: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
      },
    })
    expect(() => parseAuditResponseV2(bad)).toThrow(/outside 1..10/)
  })

  it('rejects inverted ranges', () => {
    const bad = JSON.stringify({
      scores: {
        product_intent: { score: 6, range: [7, 5], confidence: 'medium', summary: '', primaryFindings: [] },
        visual_craft: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
        trust_clarity: { score: 5, range: [4, 6], confidence: 'medium', summary: '', primaryFindings: [] },
        workflow: { score: 6, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        content_ia: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
      },
    })
    expect(() => parseAuditResponseV2(bad)).toThrow(/inverted/)
  })

  it('throws when a dimension is missing', () => {
    const bad = JSON.stringify({
      scores: {
        product_intent: { score: 6, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        // missing visual_craft
        trust_clarity: { score: 5, range: [4, 6], confidence: 'medium', summary: '', primaryFindings: [] },
        workflow: { score: 6, range: [5, 7], confidence: 'medium', summary: '', primaryFindings: [] },
        content_ia: { score: 7, range: [6, 8], confidence: 'high', summary: '', primaryFindings: [] },
      },
    })
    expect(() => parseAuditResponseV2(bad)).toThrow(/visual_craft missing/)
  })

  it('throws on missing scores object', () => {
    expect(() => parseAuditResponseV2('{"summary":"x"}')).toThrow(/missing scores/)
  })

  it('throws on no JSON object at all', () => {
    expect(() => parseAuditResponseV2('not json')).toThrow(/no JSON object/)
  })
})
