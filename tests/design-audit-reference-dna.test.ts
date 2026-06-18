import { describe, it, expect } from 'vitest'
import { toDesignDNA, summarizeDNA } from '../src/design/audit/reference/dna/derive.js'
import type {
  DesignTokens,
  ViewportTokens,
  SpacingToken,
  BorderToken,
  ComponentFingerprint,
  NavPattern,
  AnimationToken,
  TypeScaleEntry,
  ColorToken,
} from '../src/types.js'
import type { MeasurementBundle, ContrastFailure, A11yViolation } from '../src/design/audit/types.js'

// ── fixture builders (no network, no browser, no LLM) ────────────────────────

const sp = (value: string, count = 10): SpacingToken => ({ value, count, properties: ['padding'] })
const br = (borderRadius: string, count = 10): BorderToken => ({ borderRadius, count })
const comp = (fingerprint: string): ComponentFingerprint => ({ fingerprint, count: 1, styles: {} })
const nav = (selector: string): NavPattern => ({ selector, layout: {}, linkCount: 3, linkStyles: {} })
const anim = (value: string): AnimationToken => ({ property: 'transition', value, count: 1 })

const ty = (
  fontSize: string,
  fontWeight: string,
  usage: TypeScaleEntry['usage'],
  over: Partial<TypeScaleEntry> = {},
): TypeScaleEntry => ({
  fontSize,
  fontWeight,
  lineHeight: 'normal',
  letterSpacing: 'normal',
  fontFamily: 'Inter, sans-serif',
  usage,
  count: 1,
  ...over,
})

const col = (hex: string, cluster: ColorToken['cluster'], over: Partial<ColorToken> = {}): ColorToken => ({
  value: hex,
  hex,
  count: 1,
  properties: [],
  cluster,
  ...over,
})

function vp(over: Partial<ViewportTokens> = {}): ViewportTokens {
  return {
    width: 1280,
    height: 800,
    spacing: [],
    borders: [],
    shadows: [],
    components: { buttons: [], inputs: [], cards: [], nav: [] },
    animations: [],
    ...over,
  }
}

function makeTokens(over: Partial<DesignTokens> = {}): DesignTokens {
  return {
    url: 'https://example.com',
    extractedAt: '2026-01-01T00:00:00.000Z',
    viewportsAudited: ['desktop'],
    customProperties: {},
    colors: [],
    typography: { families: [], scale: [] },
    brand: {},
    logos: [],
    icons: [],
    fontFiles: [],
    images: [],
    videos: [],
    stylesheets: [],
    responsive: {},
    detectedLibraries: [],
    ...over,
  }
}

const fail = (ratio: number): ContrastFailure => ({
  selector: 'p',
  text: 'x',
  color: '#777777',
  background: '#ffffff',
  ratio,
  required: 4.5,
  fontSize: 14,
  isLargeText: false,
})

const viol = (impact: A11yViolation['impact']): A11yViolation => ({
  id: 'rule',
  impact,
  description: '',
  tags: ['wcag2aa'],
  nodes: [],
  helpUrl: '',
})

function makeMeasurements(over: {
  aaPassRate: number
  aaFailures: ContrastFailure[]
  violations: A11yViolation[]
}): MeasurementBundle {
  return {
    contrast: {
      totalChecked: 100,
      aaFailures: over.aaFailures,
      aaaFailures: [],
      summary: { aaPassRate: over.aaPassRate, aaaPassRate: 0.5 },
    },
    a11y: { ran: true, violations: over.violations, passes: 50 },
    hasBlockingIssues: false,
  }
}

// ── A clean, systematized design: 8px rhythm, two weights, 1.25 modular scale ─

const cleanTokens = makeTokens({
  url: 'https://clean.example',
  extractedAt: '2026-01-01T00:00:00.000Z',
  colors: [
    col('#2563eb', 'primary', { properties: ['backgroundColor'], count: 40 }),
    col('#111827', 'neutral', { properties: ['color'], count: 200 }),
    col('#ffffff', 'background', { properties: ['backgroundColor'], count: 150 }),
    col('#e5e7eb', 'border', { properties: ['borderColor'], count: 30 }),
  ],
  typography: {
    families: [{ family: 'Inter', weights: [400, 700], classification: 'body' }],
    scale: [
      ty('16px', '400', 'body', { lineHeight: '24px', tag: 'p', count: 50 }),
      ty('20px', '700', 'heading', { lineHeight: '28px', tag: 'h3', count: 8 }),
      ty('25px', '700', 'heading', { lineHeight: '32px', tag: 'h2', count: 4 }),
      ty('31.25px', '700', 'heading', { lineHeight: '40px', tag: 'h1', count: 2 }),
    ],
  },
  responsive: {
    desktop: vp({
      gridBaseUnit: 8,
      spacing: [sp('16px', 60), sp('8px', 40), sp('24px', 30), sp('48px', 10), sp('32px', 20)],
      borders: [br('8px', 30), br('4px', 10)],
      components: { buttons: [comp('btn-a')], inputs: [], cards: [comp('card-a')], nav: [nav('nav.main')] },
      animations: [anim('all 0.2s ease')],
    }),
  },
})

// ── An inconsistent design: irregular spacing + sizes, many component patterns ─

const messyTokens = makeTokens({
  url: 'https://messy.example',
  colors: [
    col('#ff0000', 'primary'),
    col('#00aa00', 'secondary'),
    col('#ffaa00', 'accent'),
    col('#333333', 'neutral'),
    col('#ffffff', 'background'),
    col('#cccccc', 'border'),
  ],
  typography: {
    families: [
      { family: 'Arial', weights: [400], classification: 'body' },
      { family: 'Georgia', weights: [700], classification: 'heading' },
      { family: 'Courier', weights: [400], classification: 'mono' },
    ],
    scale: [
      ty('13px', '400', 'body'),
      ty('14px', '400', 'body'),
      ty('16px', '400', 'body'),
      ty('19px', '500', 'label'),
      ty('28px', '700', 'heading'),
      ty('44px', '800', 'heading'),
    ],
  },
  responsive: {
    desktop: vp({
      gridBaseUnit: undefined,
      spacing: [sp('3px'), sp('7px'), sp('11px'), sp('13px'), sp('19px')],
      borders: [br('2px'), br('5px'), br('11px')],
      components: {
        buttons: [comp('b1'), comp('b2'), comp('b3'), comp('b4'), comp('b5')],
        inputs: [comp('i1'), comp('i2'), comp('i3')],
        cards: [comp('c1'), comp('c2'), comp('c3'), comp('c4')],
        nav: [nav('nav.top'), nav('nav.side')],
      },
    }),
  },
})

// ── A design carrying deterministic measurements + display type + multi-viewport ─

const measuredTokens = makeTokens({
  url: 'https://measured.example',
  detectedLibraries: ['GSAP', 'Framer Motion', 'jQuery'],
  typography: {
    families: [{ family: 'Inter', weights: [400, 800], classification: 'body' }],
    scale: [ty('16px', '400', 'body', { lineHeight: '150%' }), ty('56px', '800', 'heading')],
  },
  responsive: {
    desktop: vp({
      gridBaseUnit: 8,
      spacing: [sp('8px'), sp('16px'), sp('24px')],
      borders: [br('12px')],
      animations: [anim('transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)')],
    }),
    mobile: vp({
      width: 390,
      height: 844,
      gridBaseUnit: 8,
      spacing: [sp('8px'), sp('12px'), sp('16px')],
      borders: [br('12px'), br('9999px')],
    }),
  },
})

const measurements = makeMeasurements({
  aaPassRate: 0.82,
  aaFailures: [fail(3.4), fail(2.1)],
  violations: [viol('critical'), viol('serious'), viol('minor')],
})

describe('toDesignDNA (pure core)', () => {
  it('carries identity through and detects a clean modular type scale', () => {
    const dna = toDesignDNA(cleanTokens)

    expect(dna.url).toBe('https://clean.example')
    expect(dna.capturedAt).toBe('2026-01-01T00:00:00.000Z')

    // steps sorted ascending; roles + unitless line-height derived
    expect(dna.type.steps.map((s) => s.fontSizePx)).toEqual([16, 20, 25, 31.25])
    expect(dna.type.steps[0]).toMatchObject({ fontSizePx: 16, weight: 400, lineHeight: 1.5, role: 'body', family: 'Inter' })
    expect(dna.type.steps[3]).toMatchObject({ fontSizePx: 31.25, weight: 700, role: 'heading' })
    expect(dna.type.ratio).toBe(1.25)
    expect(dna.type.families).toEqual([{ family: 'Inter', role: 'body', weights: [400, 700] }])
  })

  it('carries colour roles through from the precomputed cluster (no re-clustering)', () => {
    const dna = toDesignDNA(cleanTokens)
    expect(dna.color.roles.primary).toEqual(['#2563eb'])
    expect(dna.color.roles.neutral).toEqual(['#111827'])
    expect(dna.color.roles.background).toEqual(['#ffffff'])
    expect(dna.color.roles.border).toEqual(['#e5e7eb'])
    expect(dna.color.roles.secondary).toEqual([])
    expect(dna.color.roles.accent).toEqual([])
    expect(dna.color.contrastFloor).toBeUndefined()
  })

  it('derives the spacing rhythm, radii, motion and components for a clean design', () => {
    const dna = toDesignDNA(cleanTokens)
    expect(dna.spacing.baseUnit).toBe(8)
    expect(dna.spacing.steps).toEqual([8, 16, 24, 32, 48])
    expect(dna.spacing.density).toBe('sparse')
    expect(dna.radii.steps).toEqual([4, 8])
    expect(dna.motion.durationsMs).toEqual([200])
    expect(dna.motion.easings).toContain('ease')
    expect(dna.motion.libraries).toEqual([])
    expect(dna.components).toEqual({ buttons: 1, inputs: 0, cards: 1, nav: 1 })
    expect(dna.layout.gridBaseUnit).toBe(8)
    expect(dna.layout.density).toBe('sparse')
    expect(dna.signals).toBeUndefined()
  })

  it('reports no ratio / no base unit and a dense layout for an inconsistent design', () => {
    const dna = toDesignDNA(messyTokens)
    expect(dna.type.ratio).toBeUndefined()
    expect(dna.spacing.baseUnit).toBeUndefined()
    expect(dna.spacing.density).toBe('dense')
    expect(dna.components).toEqual({ buttons: 5, inputs: 3, cards: 4, nav: 2 })
    expect(dna.layout.archetype).toBe('card-grid')
    // every colour role is populated when the token set spans all clusters
    for (const role of ['primary', 'secondary', 'accent', 'neutral', 'background', 'border'] as const) {
      expect(dna.color.roles[role].length).toBeGreaterThan(0)
    }
  })

  it('folds measurements into signals, classifies display type, and merges viewports', () => {
    const dna = toDesignDNA(measuredTokens, measurements)

    // display split: a heading at/above 40px becomes a display step
    const big = dna.type.steps.find((s) => s.fontSizePx === 56)
    expect(big?.role).toBe('display')
    // percentage line-height normalised to a unitless ratio
    expect(dna.type.steps.find((s) => s.fontSizePx === 16)?.lineHeight).toBe(1.5)

    // multi-viewport spacing + radii merged to distinct sorted scales
    expect(dna.spacing.steps).toEqual([8, 12, 16, 24])
    expect(dna.spacing.baseUnit).toBe(8)
    expect(dna.radii.steps).toEqual([12, 9999])

    // motion parsed from the transition shorthand
    expect(dna.motion.durationsMs).toEqual([300])
    expect(dna.motion.easings).toEqual(['cubic-bezier(0.4,0,0.2,1)'])
    expect(dna.motion.libraries).toEqual(['Framer Motion', 'GSAP'])

    // deterministic signals from measurements (never fabricated)
    expect(dna.color.contrastFloor).toBe(2.1)
    expect(dna.signals).toEqual({ contrastAaPassRate: 0.82, a11yBlockingCount: 2 })
  })

  it('is deterministic: identical tokens yield a deeply-equal DNA', () => {
    expect(toDesignDNA(cleanTokens)).toEqual(toDesignDNA(cleanTokens))
  })
})

describe('summarizeDNA', () => {
  it('produces a stable summary and respects the maxChars budget', () => {
    const dna = toDesignDNA(cleanTokens)
    const full = summarizeDNA(dna)
    expect(full).toContain('type:')
    expect(full).toContain('spacing: base 8 px')

    const clipped = summarizeDNA(dna, { maxChars: 60 })
    expect(clipped.length).toBeLessThanOrEqual(60)
    expect(clipped.endsWith('…')).toBe(true)
  })
})
