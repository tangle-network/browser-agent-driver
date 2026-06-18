/**
 * Design-DNA derivatives for RETRIEVAL — the two PURE projections of a
 * `DesignDNA` the reference engine needs before it can match exemplars.
 *
 *  - `aestheticDescriptor` renders a DNA as a compact, qualitative aesthetic
 *    PHRASE — the text the `EmbeddingProvider` embeds. It deliberately does NOT
 *    overlap `summarizeDNA` (dna/derive.ts): that summary is a numeric SPEC dump
 *    for prompt/judge injection (exact px lists, hex values); this is a bag of
 *    aesthetic KEYWORDS (density, archetype, scale character, palette
 *    temperature, roundness, motion energy) chosen so semantically-similar
 *    designs land near each other in embedding space. Same field-traversal order
 *    as `summarizeDNA`, no shared logic — neither duplicates the other.
 *  - `structuralFeatures` renders a DNA as a deterministic, fixed-length numeric
 *    vector — the matcher's optional secondary (structural) similarity signal.
 *    The matcher derives the exemplar side of this comparison with the SAME
 *    function, so both sides live in one feature space.
 *
 * Both are pure: no IO, no LLM, no browser; identical inputs → identical output.
 */

import type { DesignDNA, ColorRole } from '../contracts.js'

const round2 = (n: number): number => Math.round(n * 100) / 100
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

const COLOR_ROLE_ORDER: ColorRole[] = ['primary', 'secondary', 'accent', 'neutral', 'background', 'border']

/** Parse `#rgb` / `#rrggbb` into 0-255 channels, or undefined for anything else. */
function parseHex(hex: string): { r: number; g: number; b: number } | undefined {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return undefined
  const h = m[1]
  const full = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return { r, g, b }
}

/**
 * Qualitative colour temperature of a hex: warm (red-led), cool (blue-led) or
 * neutral (low saturation / green-led). A coarse aesthetic cue for retrieval.
 */
function colorTemperature(hex: string): 'warm' | 'cool' | 'neutral' {
  const rgb = parseHex(hex)
  if (!rgb) return 'neutral'
  const { r, g, b } = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const sat = max === 0 ? 0 : (max - min) / max
  if (sat < 0.15) return 'neutral'
  if (r >= b && r >= g) return 'warm'
  if (b >= r && b >= g) return 'cool'
  return 'neutral'
}

/** Aggressiveness of the modular type scale, as an aesthetic word. */
function scaleCharacter(ratio?: number): string {
  if (ratio === undefined) return 'irregular scale'
  if (ratio < 1.18) return `tight scale ~${round2(ratio)}`
  if (ratio < 1.4) return `modular scale ~${round2(ratio)}`
  return `dramatic scale ~${round2(ratio)}`
}

/** Corner roundness as an aesthetic word, from the largest radius. */
function roundnessCharacter(steps: number[]): string {
  if (steps.length === 0) return 'sharp corners'
  const max = Math.max(...steps)
  if (max >= 999) return 'pill corners'
  if (max >= 16) return `very rounded corners ${max}px`
  if (max >= 6) return `rounded corners ${max}px`
  return `slightly rounded corners ${max}px`
}

/** Motion energy as an aesthetic word. */
function motionCharacter(dna: DesignDNA): string {
  const { durationsMs, libraries } = dna.motion
  if (libraries.length > 0) return `animated motion (${libraries.join(' ')})`
  if (durationsMs.length === 0) return 'static, no motion'
  const median = durationsMs[Math.floor(durationsMs.length / 2)]
  if (median <= 200) return `snappy motion ~${median}ms`
  if (median <= 450) return `smooth motion ~${median}ms`
  return `slow motion ~${median}ms`
}

/** Contrast posture as an aesthetic word, when a floor was measured. */
function contrastCharacter(floor?: number): string | undefined {
  if (floor === undefined) return undefined
  if (floor >= 7) return 'high-contrast'
  if (floor >= 4.5) return 'adequate-contrast'
  return 'low-contrast'
}

/**
 * Render a `DesignDNA` as a budget-bounded, qualitative aesthetic descriptor for
 * embedding/retrieval. Deterministic and IO-free; clipped to `maxChars` so an
 * embedder's token budget can never be blown.
 */
export function aestheticDescriptor(dna: DesignDNA, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? 600

  const displayLed = dna.type.steps.some((s) => s.role === 'display')
  const families = dna.type.families.map((f) => f.family).filter(Boolean)
  const typeParts = [
    `${dna.type.steps.length}-step ${scaleCharacter(dna.type.ratio)}`,
    displayLed ? 'display-led' : 'text-led',
    families.length ? `families ${families.join(' ')}` : 'system fonts',
  ]

  const populatedRoles = COLOR_ROLE_ORDER.filter((r) => dna.color.roles[r].length > 0)
  const primaryHex = dna.color.roles.primary[0] ?? dna.color.roles.accent[0]
  const paletteTemp = primaryHex ? colorTemperature(primaryHex) : 'neutral'
  const paletteSize = populatedRoles.length <= 2 ? 'minimal palette' : populatedRoles.length >= 5 ? 'rich palette' : 'balanced palette'
  const contrastWord = contrastCharacter(dna.color.contrastFloor)
  const colorParts = [`${paletteTemp} ${paletteSize}`, `${populatedRoles.length} roles`]
  if (contrastWord) colorParts.push(contrastWord)

  const c = dna.components
  const lines = [
    `${dna.layout.density} density, ${dna.layout.archetype} archetype`,
    `type: ${typeParts.join(', ')}`,
    `colour: ${colorParts.join(', ')}`,
    `spacing: ${dna.spacing.density} rhythm${dna.spacing.baseUnit !== undefined ? ` on ${dna.spacing.baseUnit}px grid` : ', no clear grid'}`,
    `form: ${roundnessCharacter(dna.radii.steps)}`,
    `motion: ${motionCharacter(dna)}`,
    `components: ${c.buttons} button, ${c.inputs} input, ${c.cards} card, ${c.nav} nav patterns`,
  ]
  const body = lines.join('; ')
  return body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body
}

// Fixed feature layout — index order is the contract, every slot is bounded to
// ~[0,1] so cosine similarity over the vector stays well-conditioned. Changing
// the order or length is a breaking change to any corpus embedded against it.
const TYPE_STEP_SCALE = 8
const TYPE_FAMILY_SCALE = 4
const COLOR_ROLE_COUNT = 6
const MAX_CONTRAST_RATIO = 21
const MAX_GRID_UNIT = 16
const SPACING_STEP_SCALE = 10
const RADIUS_ROUNDNESS_SCALE = 32
const RADIUS_STEP_SCALE = 6
const MOTION_DURATION_SCALE = 6
const COMPONENT_SCALE = 8
const NAV_SCALE = 4

const DENSITY_SCORE: Record<DesignDNA['layout']['density'], number> = {
  sparse: 0,
  balanced: 0.5,
  dense: 1,
}

/**
 * Project a `DesignDNA` onto a deterministic, fixed-length structural feature
 * vector. Order-stable and identical across calls; every component is bounded so
 * the vector is safe to feed straight into `cosineSimilarity`. Missing signals
 * collapse to a neutral 0 rather than being dropped, keeping the length fixed.
 */
export function structuralFeatures(dna: DesignDNA): number[] {
  const populatedRoles = COLOR_ROLE_ORDER.filter((r) => dna.color.roles[r].length > 0).length
  const maxRadius = dna.radii.steps.length ? Math.max(...dna.radii.steps) : 0
  const c = dna.components
  return [
    clamp01(dna.type.steps.length / TYPE_STEP_SCALE),
    dna.type.ratio !== undefined ? clamp01((dna.type.ratio - 1) / 0.6) : 0,
    clamp01(dna.type.families.length / TYPE_FAMILY_SCALE),
    clamp01(populatedRoles / COLOR_ROLE_COUNT),
    dna.color.contrastFloor !== undefined ? clamp01(dna.color.contrastFloor / MAX_CONTRAST_RATIO) : 0,
    dna.spacing.baseUnit !== undefined ? clamp01(dna.spacing.baseUnit / MAX_GRID_UNIT) : 0,
    clamp01(dna.spacing.steps.length / SPACING_STEP_SCALE),
    DENSITY_SCORE[dna.spacing.density],
    clamp01(maxRadius / RADIUS_ROUNDNESS_SCALE),
    clamp01(dna.radii.steps.length / RADIUS_STEP_SCALE),
    clamp01(dna.motion.durationsMs.length / MOTION_DURATION_SCALE),
    dna.motion.libraries.length > 0 ? 1 : 0,
    clamp01(c.buttons / COMPONENT_SCALE),
    clamp01(c.inputs / COMPONENT_SCALE),
    clamp01(c.cards / COMPONENT_SCALE),
    clamp01(c.nav / NAV_SCALE),
  ].map(round2)
}
