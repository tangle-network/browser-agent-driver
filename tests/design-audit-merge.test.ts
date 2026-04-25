import { describe, it, expect } from 'vitest'
import {
  conservativeScore,
  resolveAuditPasses,
  DEFAULT_CONSERVATIVE_WEIGHTS,
  DEFAULT_DEEP_PASSES_BY_TYPE,
  PASS_DEFINITIONS,
  type AuditOverrides,
} from '../src/design/audit/evaluate.js'
import type { PageClassification } from '../src/design/audit/types.js'

function classification(overrides: Partial<PageClassification> = {}): PageClassification {
  return {
    type: 'saas-app',
    domain: 'general',
    framework: null,
    designSystem: 'fully-custom',
    maturity: 'shipped',
    intent: 'workspace home',
    confidence: 0.9,
    ...overrides,
  }
}

describe('conservativeScore', () => {
  it('returns 5 with no scores (defensive default)', () => {
    expect(conservativeScore([])).toBe(5)
  })

  it('returns the single score unchanged when one pass ran', () => {
    expect(conservativeScore([7.3])).toBe(7.3)
  })

  it('weights min more heavily than mean by default', () => {
    // Default weights 0.65/0.35: scores=[5,9] → 5*0.65 + 7*0.35 = 5.7
    expect(conservativeScore([5, 9])).toBe(5.7)
  })

  it('respects an override weight pair', () => {
    // [5, 9]: min=5, mean=(5+9)/2=7, 0.5*5 + 0.5*7 = 6
    expect(conservativeScore([5, 9], { min: 0.5, mean: 0.5 })).toBe(6)
    // 80/20: 0.8*5 + 0.2*7 = 5.4
    expect(conservativeScore([5, 9], { min: 0.8, mean: 0.2 })).toBe(5.4)
  })

  it('normalises non-1.0 weight pairs', () => {
    // [4,8] with (1, 1) is the same as (0.5, 0.5): mean(4,8)=6, min=4 → 5
    expect(conservativeScore([4, 8], { min: 1, mean: 1 })).toBe(5)
  })

  it('falls back to default when both weights are zero', () => {
    expect(conservativeScore([5, 9], { min: 0, mean: 0 })).toBe(
      conservativeScore([5, 9], DEFAULT_CONSERVATIVE_WEIGHTS),
    )
  })

  it('rounds to 1 decimal place', () => {
    // [5,7,8] mean=6.667, min=5 → 5*0.65 + 6.667*0.35 = 5.583... → 5.6
    expect(conservativeScore([5, 7, 8])).toBe(5.6)
  })
})

describe('resolveAuditPasses — classification-aware deep mode', () => {
  it('returns single standard pass by default', () => {
    expect(resolveAuditPasses()).toEqual(['standard'])
  })

  it('routes deep to product+visual+content for marketing', () => {
    expect(
      resolveAuditPasses('deep', { classification: classification({ type: 'marketing' }) }),
    ).toEqual(['product', 'visual', 'content'])
  })

  it('routes deep to product+visual+trust for ecommerce', () => {
    expect(
      resolveAuditPasses('deep', { classification: classification({ type: 'ecommerce' }) }),
    ).toEqual(['product', 'visual', 'trust'])
  })

  it('routes deep to product+visual+workflow for saas-app', () => {
    expect(
      resolveAuditPasses('deep', { classification: classification({ type: 'saas-app' }) }),
    ).toEqual(['product', 'visual', 'workflow'])
  })

  it('falls back to default deep bundle when classification is missing', () => {
    expect(resolveAuditPasses('deep')).toEqual(DEFAULT_DEEP_PASSES_BY_TYPE.default)
  })

  it('respects override deepPassesByPageType', () => {
    const overrides: AuditOverrides = {
      deepPassesByPageType: { 'saas-app': ['product', 'workflow'] },
    }
    expect(
      resolveAuditPasses('deep', { classification: classification({ type: 'saas-app' }), overrides }),
    ).toEqual(['product', 'workflow'])
  })

  it('still honours max as the full set', () => {
    expect(resolveAuditPasses('max')).toEqual(['product', 'visual', 'trust', 'workflow', 'content'])
  })

  it('honours explicit comma list regardless of classification', () => {
    expect(
      resolveAuditPasses('content, visual', { classification: classification({ type: 'marketing' }) }),
    ).toEqual(['content', 'visual'])
  })
})

describe('PASS_DEFINITIONS shape', () => {
  it('every pass declares a per-pass systemOpener (no generic visual-only opener)', () => {
    for (const id of Object.keys(PASS_DEFINITIONS) as Array<keyof typeof PASS_DEFINITIONS>) {
      const pass = PASS_DEFINITIONS[id]!
      expect(pass.systemOpener).toBeTruthy()
      expect(pass.systemOpener.length).toBeGreaterThan(40)
    }
  })

  it('the trust pass opener does NOT claim visual-only scope', () => {
    expect(PASS_DEFINITIONS.trust.systemOpener.toLowerCase()).not.toContain('visual layer only')
    expect(PASS_DEFINITIONS.trust.systemOpener.toLowerCase()).not.toContain('visual quality only')
  })

  it('the product pass opener does NOT claim visual-only scope', () => {
    expect(PASS_DEFINITIONS.product.systemOpener.toLowerCase()).not.toContain('visual layer only')
  })
})
