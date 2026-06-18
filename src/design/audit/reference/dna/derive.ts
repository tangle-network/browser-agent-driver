/**
 * Design-DNA derivation — the PURE core of the reference engine's FOUNDATION.
 *
 * `toDesignDNA` folds an already-extracted `DesignTokens` record (+ optional
 * deterministic `MeasurementBundle`) into the normalised, browser-free
 * `DesignDNA` identity. It performs NO IO, NO LLM, NO browser work and is fully
 * deterministic, so it unit-tests on static token fixtures alone.
 *
 * Altitude discipline (per ARCHITECTURE.md §0): this is a LOSSY normalisation of
 * tokens. It CARRIES THROUGH the already-computed `ColorToken.cluster` and
 * `ViewportTokens.gridBaseUnit` rather than re-clustering colours or re-detecting
 * a grid — those decisions belong to the token extractor, not here.
 */

import type {
  DesignTokens,
  ViewportTokens,
  MeasurementBundle,
  DesignDNA,
  TypeStepDNA,
  FontRoleDNA,
  ColorRole,
  Density,
  MotionDNA,
  ComponentPatternDNA,
} from '../contracts.js'

// Adjacent type-scale ratios this close to each other (max/min) read as one
// modular scale; beyond it the scale is irregular and no ratio is reported.
const RATIO_CONSISTENCY_TOLERANCE = 1.12
// CSS `line-height: normal` has no numeric value to read; this is the
// conventional ~1.2 approximation used only when the keyword/garbage is present.
const NORMAL_LINE_HEIGHT = 1.2
// A heading at or above this rendered size is classified as a display step.
const DISPLAY_MIN_PX = 40
// Distinct component-pattern thresholds for the whitespace-free density proxy.
const SPARSE_MAX_PATTERNS = 4
const BALANCED_MAX_PATTERNS = 12
// Substrings that mark a detected library as motion-related.
const ANIMATION_LIB_PATTERNS = [
  'gsap',
  'framer',
  'lottie',
  'anime',
  'aos',
  'velocity',
  'react-spring',
  'lenis',
  'scrollmagic',
  'rive',
  'three.js',
  'threejs',
]

const round2 = (n: number): number => Math.round(n * 100) / 100

function primaryFamily(stack: string): string {
  const first = stack.split(',')[0]?.trim() ?? ''
  return first.replace(/^["']|["']$/g, '')
}

function parseWeight(raw: string): number {
  const n = parseInt(raw, 10)
  if (Number.isFinite(n) && n > 0) return n
  const named: Record<string, number> = { normal: 400, bold: 700, lighter: 300, bolder: 700 }
  return named[raw.trim().toLowerCase()] ?? 400
}

function lineHeightRatio(raw: string, fontSizePx: number): number {
  const trimmed = raw.trim()
  if (trimmed === 'normal' || trimmed === '') return NORMAL_LINE_HEIGHT
  const px = trimmed.match(/^([\d.]+)px$/)
  if (px && fontSizePx > 0) return round2(parseFloat(px[1]) / fontSizePx)
  const pct = trimmed.match(/^([\d.]+)%$/)
  if (pct) return round2(parseFloat(pct[1]) / 100)
  const num = parseFloat(trimmed)
  if (Number.isFinite(num) && !/[a-z%]/i.test(trimmed)) return round2(num)
  return NORMAL_LINE_HEIGHT
}

function stepRole(usage: DesignTokens['typography']['scale'][number]['usage'], fontSizePx: number): TypeStepDNA['role'] {
  if (usage === 'heading') return fontSizePx >= DISPLAY_MIN_PX ? 'display' : 'heading'
  return usage
}

function parsePx(raw: string): number | undefined {
  const m = raw.trim().match(/^(-?[\d.]+)px$/)
  if (!m) return undefined
  const n = parseFloat(m[1])
  return Number.isFinite(n) ? n : undefined
}

function detectRatio(steps: TypeStepDNA[]): number | undefined {
  const sizes = [...new Set(steps.map((s) => s.fontSizePx))].sort((a, b) => a - b)
  if (sizes.length < 2) return undefined
  const ratios: number[] = []
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i - 1] > 0) ratios.push(sizes[i] / sizes[i - 1])
  }
  if (ratios.length === 0) return undefined
  const min = Math.min(...ratios)
  const max = Math.max(...ratios)
  if (min <= 0 || max / min > RATIO_CONSISTENCY_TOLERANCE) return undefined
  return round2(ratios.reduce((a, b) => a + b, 0) / ratios.length)
}

function deriveDensity(componentPatternCount: number, whitespaceRatio?: number): Density {
  if (whitespaceRatio !== undefined) {
    if (whitespaceRatio >= 0.6) return 'sparse'
    if (whitespaceRatio >= 0.35) return 'balanced'
    return 'dense'
  }
  if (componentPatternCount <= SPARSE_MAX_PATTERNS) return 'sparse'
  if (componentPatternCount <= BALANCED_MAX_PATTERNS) return 'balanced'
  return 'dense'
}

function aggregateSpacingSteps(responsive: Record<string, ViewportTokens>): number[] {
  const set = new Set<number>()
  for (const vp of Object.values(responsive)) {
    for (const s of vp.spacing) {
      const px = parsePx(s.value)
      if (px !== undefined && px > 0) set.add(Math.round(px))
    }
  }
  return [...set].sort((a, b) => a - b)
}

function aggregateRadii(responsive: Record<string, ViewportTokens>): number[] {
  const set = new Set<number>()
  for (const vp of Object.values(responsive)) {
    for (const b of vp.borders) {
      const px = parsePx(b.borderRadius)
      if (px !== undefined && px > 0) set.add(Math.round(px))
    }
  }
  return [...set].sort((a, b) => a - b)
}

function pickGridBaseUnit(responsive: Record<string, ViewportTokens>): number | undefined {
  const desktop = responsive['desktop']
  if (desktop && desktop.gridBaseUnit !== undefined) return desktop.gridBaseUnit
  const counts = new Map<number, number>()
  for (const vp of Object.values(responsive)) {
    if (vp.gridBaseUnit !== undefined) counts.set(vp.gridBaseUnit, (counts.get(vp.gridBaseUnit) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined
  let best: number | undefined
  let bestCount = -1
  // Sort by unit asc first so an equal-frequency tie resolves to the smallest unit.
  for (const [unit, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      bestCount = count
      best = unit
    }
  }
  return best
}

function parseDurationsMs(value: string): number[] {
  const out: number[] = []
  const re = /(\d*\.?\d+)\s*(ms|s)\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const n = parseFloat(m[1])
    if (!Number.isFinite(n)) continue
    const ms = m[2].toLowerCase() === 's' ? n * 1000 : n
    if (ms > 0) out.push(Math.round(ms))
  }
  return out
}

function parseEasings(value: string): string[] {
  const out: string[] = []
  const fn = /(cubic-bezier|steps)\s*\([^)]*\)/gi
  let m: RegExpExecArray | null
  while ((m = fn.exec(value)) !== null) out.push(m[0].replace(/\s+/g, ''))
  const named = /\b(ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)\b/gi
  while ((m = named.exec(value)) !== null) out.push(m[1].toLowerCase())
  return out
}

function detectAnimationLibraries(libs: string[]): string[] {
  const out = new Set<string>()
  for (const lib of libs) {
    const norm = lib.toLowerCase()
    if (ANIMATION_LIB_PATTERNS.some((p) => norm.includes(p))) out.add(lib)
  }
  return [...out].sort()
}

function deriveMotion(responsive: Record<string, ViewportTokens>, detectedLibraries: string[]): MotionDNA {
  const durations = new Set<number>()
  const easings = new Set<string>()
  for (const vp of Object.values(responsive)) {
    for (const a of vp.animations) {
      for (const d of parseDurationsMs(a.value)) durations.add(d)
      for (const e of parseEasings(a.value)) easings.add(e)
    }
  }
  return {
    durationsMs: [...durations].sort((a, b) => a - b),
    easings: [...easings].sort(),
    libraries: detectAnimationLibraries(detectedLibraries),
  }
}

function distinctComponentCount(
  responsive: Record<string, ViewportTokens>,
  kind: 'buttons' | 'inputs' | 'cards',
): number {
  const set = new Set<string>()
  for (const vp of Object.values(responsive)) {
    for (const c of vp.components[kind]) set.add(c.fingerprint)
  }
  return set.size
}

function distinctNavCount(responsive: Record<string, ViewportTokens>): number {
  const set = new Set<string>()
  for (const vp of Object.values(responsive)) {
    for (const n of vp.components.nav) set.add(n.selector)
  }
  return set.size
}

/**
 * A coarse, deterministic structural archetype label derived from the dominant
 * component composition. Free-form by contract — a hint for retrieval, never a
 * forced bucket — so novel compositions fall through to `content-flow`.
 */
function deriveArchetype(c: ComponentPatternDNA): string {
  if (c.buttons === 0 && c.inputs === 0 && c.cards === 0 && c.nav === 0) return 'minimal'
  if (c.inputs >= 3 && c.inputs >= c.cards) return 'form-shell'
  if (c.cards >= 3 && c.cards >= c.inputs) return 'card-grid'
  if (c.nav >= 1 && c.buttons >= 2 && c.cards < 3) return 'nav-content'
  return 'content-flow'
}

/**
 * Fold a `DesignTokens` record (+ optional measurements) into a `DesignDNA`.
 * Pure and deterministic: identical inputs always yield an identical DNA.
 */
export function toDesignDNA(tokens: DesignTokens, measurements?: MeasurementBundle): DesignDNA {
  const steps: TypeStepDNA[] = tokens.typography.scale
    .map((e) => {
      const fontSizePx = round2(parseFloat(e.fontSize))
      return {
        fontSizePx,
        weight: parseWeight(e.fontWeight),
        lineHeight: lineHeightRatio(e.lineHeight, fontSizePx),
        family: primaryFamily(e.fontFamily),
        role: stepRole(e.usage, fontSizePx),
      }
    })
    .filter((s) => Number.isFinite(s.fontSizePx) && s.fontSizePx > 0)
    .sort((a, b) => a.fontSizePx - b.fontSizePx)

  const families: FontRoleDNA[] = tokens.typography.families.map((f) => ({
    family: f.family,
    role: f.classification,
    weights: [...f.weights].sort((a, b) => a - b),
  }))

  // Colour roles are a 1:1 carry-through of the precomputed cluster — never a
  // re-clustering. Tokens with no cluster are deliberately dropped, not guessed.
  const roles: Record<ColorRole, string[]> = {
    primary: [],
    secondary: [],
    accent: [],
    neutral: [],
    background: [],
    border: [],
  }
  for (const c of tokens.colors) {
    if (!c.cluster) continue
    const bucket = roles[c.cluster]
    if (!bucket.includes(c.hex)) bucket.push(c.hex)
  }
  const failures = measurements?.contrast.aaFailures ?? []
  const contrastFloor = failures.length > 0 ? round2(Math.min(...failures.map((f) => f.ratio))) : undefined

  const components: ComponentPatternDNA = {
    buttons: distinctComponentCount(tokens.responsive, 'buttons'),
    inputs: distinctComponentCount(tokens.responsive, 'inputs'),
    cards: distinctComponentCount(tokens.responsive, 'cards'),
    nav: distinctNavCount(tokens.responsive),
  }

  const baseUnit = pickGridBaseUnit(tokens.responsive)
  const density = deriveDensity(components.buttons + components.inputs + components.cards + components.nav)

  const signals: DesignDNA['signals'] = measurements
    ? {
        contrastAaPassRate: measurements.contrast.summary.aaPassRate,
        a11yBlockingCount: measurements.a11y.violations.filter(
          (v) => v.impact === 'critical' || v.impact === 'serious',
        ).length,
      }
    : undefined

  return {
    url: tokens.url,
    capturedAt: tokens.extractedAt,
    type: {
      steps,
      ratio: detectRatio(steps),
      families,
    },
    color: {
      roles,
      contrastFloor,
    },
    spacing: {
      baseUnit,
      steps: aggregateSpacingSteps(tokens.responsive),
      density,
    },
    radii: {
      steps: aggregateRadii(tokens.responsive),
    },
    motion: deriveMotion(tokens.responsive, tokens.detectedLibraries),
    layout: {
      columns: undefined,
      gridBaseUnit: baseUnit,
      whitespaceRatio: undefined,
      density,
      archetype: deriveArchetype(components),
    },
    components,
    signals,
  }
}

/**
 * A budget-bounded, prompt-ready summary of a `DesignDNA`. Deterministic and
 * IO-free; truncates to `maxChars` so an injected reference can never blow the
 * generation/judge token budget.
 */
export function summarizeDNA(dna: DesignDNA, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 1200
  const sizes = dna.type.steps.map((s) => s.fontSizePx).join('/')
  const ratio = dna.type.ratio !== undefined ? `~${dna.type.ratio}×` : 'irregular'
  const fams = dna.type.families.map((f) => `${f.family}(${f.role})`).join(', ')
  const colorLine = (Object.keys(dna.color.roles) as ColorRole[])
    .filter((r) => dna.color.roles[r].length > 0)
    .map((r) => `${r}:${dna.color.roles[r].join(' ')}`)
    .join('  ')
  const lines = [
    `type: ${sizes || 'none'} px, scale ${ratio}; families ${fams || 'none'}`,
    `color: ${colorLine || 'none'}${dna.color.contrastFloor !== undefined ? ` (contrast floor ${dna.color.contrastFloor})` : ''}`,
    `spacing: base ${dna.spacing.baseUnit ?? 'none'} px, steps ${dna.spacing.steps.join('/') || 'none'}, ${dna.spacing.density}`,
    `radii: ${dna.radii.steps.join('/') || 'none'} px`,
    `motion: ${dna.motion.durationsMs.join('/') || 'none'} ms, ${dna.motion.easings.join(' ') || 'no-easing'}${dna.motion.libraries.length ? `, libs ${dna.motion.libraries.join(' ')}` : ''}`,
    `layout: ${dna.layout.archetype}, ${dna.layout.density}`,
    `components: ${dna.components.buttons}btn ${dna.components.inputs}input ${dna.components.cards}card ${dna.components.nav}nav`,
  ]
  if (dna.signals) {
    lines.push(
      `signals: contrast AA ${dna.signals.contrastAaPassRate ?? '?'}, a11y blocking ${dna.signals.a11yBlockingCount ?? '?'}`,
    )
  }
  const body = lines.join('\n')
  return body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body
}
