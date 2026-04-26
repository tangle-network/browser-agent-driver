import { describe, it, expect } from 'vitest'
import {
  classifyByUrl,
  classifyByDom,
  classifyEnsemble,
  deriveHeuristics,
  ENSEMBLE_INTERNALS,
} from '../src/design/audit/classify-ensemble.js'
import type { DomHeuristics } from '../src/design/audit/v2/types.js'
import type { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'

function emptyHeuristics(overrides: Partial<DomHeuristics> = {}): DomHeuristics {
  return {
    formCount: 0,
    inputCount: 0,
    tableRowCount: 0,
    chartCount: 0,
    navItems: 0,
    hasFooterLinks: false,
    hasHeroSection: false,
    hasSidebar: false,
    paragraphCount: 0,
    codeBlockCount: 0,
    ...overrides,
  }
}

function fakeState(snapshot: string = ''): PageState {
  return {
    url: 'https://example.com/',
    title: 'Example',
    snapshot,
    screenshot: '',
  } as PageState
}

interface FakeBrainResult {
  type: string
  confidence: number
  intent?: string
}

function fakeBrain(result: FakeBrainResult): Brain {
  return {
    auditDesign: async () => ({
      raw: JSON.stringify({
        type: result.type,
        domain: 'unknown',
        framework: null,
        designSystem: 'unknown',
        maturity: 'shipped',
        intent: result.intent ?? '',
        confidence: result.confidence,
      }),
      score: 5,
      findings: [],
      tokensUsed: 100,
    }),
  } as unknown as Brain
}

describe('classifyByUrl — Layer 1', () => {
  it('matches /docs paths', () => {
    const sig = classifyByUrl('https://example.com/docs/intro')
    expect(sig?.type).toBe('docs')
    expect(sig?.confidence).toBeGreaterThanOrEqual(0.8)
  })
  it('matches /checkout paths', () => {
    expect(classifyByUrl('https://example.com/checkout/cart')?.type).toBe('ecommerce')
  })
  it('matches /app paths', () => {
    expect(classifyByUrl('https://example.com/app')?.type).toBe('saas-app')
  })
  it('matches /login paths', () => {
    expect(classifyByUrl('https://example.com/login')?.type).toBe('utility')
  })
  it('matches /pricing paths', () => {
    expect(classifyByUrl('https://example.com/pricing')?.type).toBe('marketing')
  })
  it('matches /blog paths', () => {
    expect(classifyByUrl('https://example.com/blog/post-1')?.type).toBe('blog')
  })
  it('roots default to weak marketing signal', () => {
    const sig = classifyByUrl('https://example.com/')
    expect(sig?.type).toBe('marketing')
    expect(sig?.confidence).toBeLessThanOrEqual(0.5)
  })
  it('returns null for unparseable urls', () => {
    expect(classifyByUrl('not a url')).toBeNull()
  })
})

describe('classifyByDom — Layer 1', () => {
  it('docs: many paragraphs + code blocks', () => {
    const sig = classifyByDom(emptyHeuristics({ codeBlockCount: 5, paragraphCount: 10 }))
    expect(sig?.type).toBe('docs')
  })
  it('dashboard: many table rows + sidebar', () => {
    const sig = classifyByDom(emptyHeuristics({ tableRowCount: 12, hasSidebar: true }))
    expect(sig?.type).toBe('dashboard')
  })
  it('saas-app: sidebar + forms', () => {
    const sig = classifyByDom(emptyHeuristics({ hasSidebar: true, formCount: 1, inputCount: 5 }))
    expect(sig?.type).toBe('saas-app')
  })
  it('utility: single form, no hero, no sidebar', () => {
    const sig = classifyByDom(emptyHeuristics({ formCount: 1, inputCount: 3 }))
    expect(sig?.type).toBe('utility')
  })
  it('blog: many paragraphs, no forms or tables', () => {
    const sig = classifyByDom(emptyHeuristics({ paragraphCount: 10 }))
    expect(sig?.type).toBe('blog')
  })
  it('marketing: hero + footer + few paragraphs', () => {
    const sig = classifyByDom(emptyHeuristics({ hasHeroSection: true, hasFooterLinks: true, paragraphCount: 3 }))
    expect(sig?.type).toBe('marketing')
  })
  it('returns null for empty input', () => {
    expect(classifyByDom(emptyHeuristics())).toBeNull()
  })
})

describe('classifyEnsemble — Layer 1', () => {
  it('fast path: URL + DOM agree → skip LLM, signalsAgreed true', async () => {
    let brainCalls = 0
    const brain = {
      auditDesign: async () => {
        brainCalls++
        return { raw: '{"type":"docs","confidence":0.9}', score: 5, findings: [], tokensUsed: 0 }
      },
    } as unknown as Brain

    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/docs/intro',
      domHeuristics: emptyHeuristics({ codeBlockCount: 5, paragraphCount: 10 }),
    })
    expect(brainCalls).toBe(0)
    expect(result.type).toBe('docs')
    expect(result.signalsAgreed).toBe(true)
    expect(result.signals.length).toBe(2)
    expect(result.ensembleConfidence).toBeGreaterThan(0.5)
    expect(result.firstPrinciplesMode).toBe(false)
  })

  it('LLM tiebreaker: signals disagree, LLM has high confidence → LLM wins', async () => {
    const brain = fakeBrain({ type: 'saas-app', confidence: 0.9, intent: 'app surface' })
    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/app',
      domHeuristics: emptyHeuristics({ paragraphCount: 10 }), // DOM says blog
    })
    expect(result.signals.length).toBe(3)
    expect(result.signals.some((s) => s.source === 'llm')).toBe(true)
  })

  it('low LLM confidence + signals disagree → unknown with dissent', async () => {
    const brain = fakeBrain({ type: 'unknown', confidence: 0.1 })
    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/app',
      domHeuristics: emptyHeuristics({ paragraphCount: 10 }),
    })
    expect(result.type).toBe('unknown')
    expect(result.signalsAgreed).toBe(false)
    expect(result.dissent).toBeDefined()
    expect(result.dissent!.length).toBeGreaterThan(0)
  })

  it('dom heuristic alone with weak url root → still produces a result', async () => {
    const brain = fakeBrain({ type: 'docs', confidence: 0.8 })
    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/',
      domHeuristics: emptyHeuristics({ codeBlockCount: 5, paragraphCount: 10 }),
    })
    // URL says marketing (root), DOM says docs. LLM tiebreaker decides.
    expect(['docs', 'marketing']).toContain(result.type)
    expect(result.signals.length).toBeGreaterThanOrEqual(2)
  })

  it('first-principles mode triggers when ensemble confidence < 0.6', async () => {
    const brain = fakeBrain({ type: 'unknown', confidence: 0.2 })
    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/',
      domHeuristics: emptyHeuristics(),
    })
    expect(result.firstPrinciplesMode).toBe(true)
  })

  it('records every signal with rationale + source', async () => {
    const brain = fakeBrain({ type: 'docs', confidence: 0.9 })
    const result = await classifyEnsemble({
      brain,
      state: fakeState(),
      url: 'https://example.com/docs',
      domHeuristics: emptyHeuristics({ paragraphCount: 10 }),
    })
    for (const sig of result.signals) {
      expect(['url-pattern', 'dom-heuristic', 'llm']).toContain(sig.source)
      expect(typeof sig.rationale).toBe('string')
      expect(sig.rationale.length).toBeGreaterThan(0)
    }
  })
})

describe('deriveHeuristics — Layer 1', () => {
  it('extracts counts from a snapshot', () => {
    const snap = `
      navigation: [Home, Docs, Pricing]
      heading "Hello"
      form
        textbox
        textbox
      paragraph "lorem"
      paragraph "ipsum"
      contentinfo: [Privacy, Terms]
    `
    const h = deriveHeuristics({ snapshot: snap } as PageState)
    expect(h.formCount).toBeGreaterThanOrEqual(1)
    expect(h.inputCount).toBeGreaterThanOrEqual(2)
    expect(h.paragraphCount).toBeGreaterThanOrEqual(2)
    expect(h.hasFooterLinks).toBe(true)
  })

  it('returns zeros for empty snapshot', () => {
    const h = deriveHeuristics({ snapshot: '' } as PageState)
    expect(h.formCount).toBe(0)
    expect(h.paragraphCount).toBe(0)
    expect(h.hasFooterLinks).toBe(false)
  })
})

describe('Ensemble internals — Layer 1', () => {
  it('exposes URL_PATTERN_RULES table for inspection', () => {
    expect(ENSEMBLE_INTERNALS.URL_PATTERN_RULES.length).toBeGreaterThanOrEqual(7)
    expect(ENSEMBLE_INTERNALS.ENSEMBLE_AGREEMENT_THRESHOLD).toBe(0.7)
    expect(ENSEMBLE_INTERNALS.LLM_FALLBACK_CONFIDENCE).toBe(0.5)
  })
})
