/**
 * Exemplar (de)serialisation + validation — the PURE corpus schema core.
 *
 * `parseExemplar` is the single fail-closed gate every corpus row passes through
 * (on load AND before write): it validates the full `Exemplar` shape — including a
 * deep `DesignDNA` walk — and returns a FRESH, whitelisted object built field by
 * field. Nothing from the raw input is ever spread or assigned wholesale, so a
 * hostile row carrying `__proto__` / `constructor` keys can neither pollute a
 * prototype nor smuggle extra fields into the corpus; unknown keys are simply
 * dropped. No `eval`, no `Function`, no dynamic require — `JSON.parse` upstream is
 * the only deserialisation, and it is treated as untrusted data.
 *
 * `isExemplar` is the boolean guard derived from the same path; `serializeExemplar`
 * is its inverse (pretty JSON, one record per file). Pure: no IO, no LLM, no
 * browser; identical inputs → identical output.
 */

import type {
  Exemplar,
  ExemplarSource,
  DesignDNA,
  PageType,
  ColorRole,
  Density,
  TypeStepDNA,
  FontRoleDNA,
  ComponentPatternDNA,
} from '../contracts.js'

const PAGE_TYPES: readonly PageType[] = [
  'marketing',
  'saas-app',
  'dashboard',
  'docs',
  'ecommerce',
  'social',
  'tool',
  'blog',
  'utility',
  'unknown',
]
const COLOR_ROLES: readonly ColorRole[] = ['primary', 'secondary', 'accent', 'neutral', 'background', 'border']
const DENSITIES: readonly Density[] = ['sparse', 'balanced', 'dense']
const STEP_ROLES: readonly TypeStepDNA['role'][] = ['display', 'heading', 'body', 'caption', 'label']
const FONT_ROLES: readonly FontRoleDNA['role'][] = ['heading', 'body', 'mono', 'display']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)
const isFiniteNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isFiniteNumber)

/** Throw a uniform, contextual rejection. Never returns. */
function fail(msg: string): never {
  throw new Error(`invalid exemplar: ${msg}`)
}

function asRecord(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) fail(`${where} must be an object`)
  return v
}

function asString(v: unknown, where: string): string {
  if (!isString(v)) fail(`${where} must be a string`)
  return v
}

function asNonEmptyString(v: unknown, where: string): string {
  const s = asString(v, where)
  if (s.length === 0) fail(`${where} must be non-empty`)
  return s
}

function asFiniteNumber(v: unknown, where: string): number {
  if (!isFiniteNumber(v)) fail(`${where} must be a finite number`)
  return v
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], where: string): T {
  if (!isString(v) || !allowed.includes(v as T)) fail(`${where} must be one of ${allowed.join(', ')}`)
  return v as T
}

function normalizeTypeStep(raw: unknown, where: string): TypeStepDNA {
  const r = asRecord(raw, where)
  return {
    fontSizePx: asFiniteNumber(r.fontSizePx, `${where}.fontSizePx`),
    weight: asFiniteNumber(r.weight, `${where}.weight`),
    lineHeight: asFiniteNumber(r.lineHeight, `${where}.lineHeight`),
    family: asString(r.family, `${where}.family`),
    role: asEnum(r.role, STEP_ROLES, `${where}.role`),
  }
}

function normalizeFontRole(raw: unknown, where: string): FontRoleDNA {
  const r = asRecord(raw, where)
  if (!isFiniteNumberArray(r.weights)) fail(`${where}.weights must be a number array`)
  return {
    family: asString(r.family, `${where}.family`),
    role: asEnum(r.role, FONT_ROLES, `${where}.role`),
    weights: [...r.weights],
  }
}

function normalizeDNA(raw: unknown): DesignDNA {
  const d = asRecord(raw, 'dna')

  const typeRaw = asRecord(d.type, 'dna.type')
  if (!Array.isArray(typeRaw.steps)) fail('dna.type.steps must be an array')
  if (!Array.isArray(typeRaw.families)) fail('dna.type.families must be an array')
  const type: DesignDNA['type'] = {
    steps: typeRaw.steps.map((s, i) => normalizeTypeStep(s, `dna.type.steps[${i}]`)),
    families: typeRaw.families.map((f, i) => normalizeFontRole(f, `dna.type.families[${i}]`)),
  }
  if (typeRaw.ratio !== undefined) type.ratio = asFiniteNumber(typeRaw.ratio, 'dna.type.ratio')

  const colorRaw = asRecord(d.color, 'dna.color')
  const rolesRaw = asRecord(colorRaw.roles, 'dna.color.roles')
  const roles = {} as Record<ColorRole, string[]>
  for (const role of COLOR_ROLES) {
    const arr = rolesRaw[role]
    if (arr !== undefined && !isStringArray(arr)) fail(`dna.color.roles.${role} must be a string array`)
    roles[role] = isStringArray(arr) ? [...arr] : []
  }
  const color: DesignDNA['color'] = { roles }
  if (colorRaw.contrastFloor !== undefined) {
    color.contrastFloor = asFiniteNumber(colorRaw.contrastFloor, 'dna.color.contrastFloor')
  }

  const spacingRaw = asRecord(d.spacing, 'dna.spacing')
  if (!isFiniteNumberArray(spacingRaw.steps)) fail('dna.spacing.steps must be a number array')
  const spacing: DesignDNA['spacing'] = {
    steps: [...spacingRaw.steps],
    density: asEnum(spacingRaw.density, DENSITIES, 'dna.spacing.density'),
  }
  if (spacingRaw.baseUnit !== undefined) spacing.baseUnit = asFiniteNumber(spacingRaw.baseUnit, 'dna.spacing.baseUnit')

  const radiiRaw = asRecord(d.radii, 'dna.radii')
  if (!isFiniteNumberArray(radiiRaw.steps)) fail('dna.radii.steps must be a number array')

  const motionRaw = asRecord(d.motion, 'dna.motion')
  if (!isFiniteNumberArray(motionRaw.durationsMs)) fail('dna.motion.durationsMs must be a number array')
  if (!isStringArray(motionRaw.easings)) fail('dna.motion.easings must be a string array')
  if (!isStringArray(motionRaw.libraries)) fail('dna.motion.libraries must be a string array')

  const layoutRaw = asRecord(d.layout, 'dna.layout')
  const layout: DesignDNA['layout'] = {
    density: asEnum(layoutRaw.density, DENSITIES, 'dna.layout.density'),
    archetype: asString(layoutRaw.archetype, 'dna.layout.archetype'),
  }
  if (layoutRaw.columns !== undefined) layout.columns = asFiniteNumber(layoutRaw.columns, 'dna.layout.columns')
  if (layoutRaw.gridBaseUnit !== undefined)
    layout.gridBaseUnit = asFiniteNumber(layoutRaw.gridBaseUnit, 'dna.layout.gridBaseUnit')
  if (layoutRaw.whitespaceRatio !== undefined)
    layout.whitespaceRatio = asFiniteNumber(layoutRaw.whitespaceRatio, 'dna.layout.whitespaceRatio')

  const compRaw = asRecord(d.components, 'dna.components')
  const components: ComponentPatternDNA = {
    buttons: asFiniteNumber(compRaw.buttons, 'dna.components.buttons'),
    inputs: asFiniteNumber(compRaw.inputs, 'dna.components.inputs'),
    cards: asFiniteNumber(compRaw.cards, 'dna.components.cards'),
    nav: asFiniteNumber(compRaw.nav, 'dna.components.nav'),
  }

  const dna: DesignDNA = {
    url: asString(d.url, 'dna.url'),
    capturedAt: asString(d.capturedAt, 'dna.capturedAt'),
    type,
    color,
    spacing,
    radii: { steps: [...radiiRaw.steps] },
    motion: {
      durationsMs: [...motionRaw.durationsMs],
      easings: [...motionRaw.easings],
      libraries: [...motionRaw.libraries],
    },
    layout,
    components,
  }

  if (d.signals !== undefined) {
    const sigRaw = asRecord(d.signals, 'dna.signals')
    const signals: NonNullable<DesignDNA['signals']> = {}
    if (sigRaw.contrastAaPassRate !== undefined)
      signals.contrastAaPassRate = asFiniteNumber(sigRaw.contrastAaPassRate, 'dna.signals.contrastAaPassRate')
    if (sigRaw.a11yBlockingCount !== undefined)
      signals.a11yBlockingCount = asFiniteNumber(sigRaw.a11yBlockingCount, 'dna.signals.a11yBlockingCount')
    dna.signals = signals
  }

  return dna
}

/**
 * Validate and normalise one raw record into a fresh `Exemplar`, or throw a typed
 * rejection. Fail-closed: a missing/ malformed `dna`, `aestheticVector`, or
 * `pageType` is rejected rather than defaulted, and the result is built by
 * whitelisting known fields (no spread of untrusted input → no prototype
 * pollution).
 */
export function parseExemplar(raw: unknown): Exemplar {
  const r = asRecord(raw, 'exemplar')
  if (!isFiniteNumberArray(r.aestheticVector) || r.aestheticVector.length === 0) {
    fail('aestheticVector must be a non-empty finite number array')
  }
  return {
    id: asNonEmptyString(r.id, 'id'),
    source: asNonEmptyString(r.source, 'source') as ExemplarSource,
    url: asString(r.url, 'url'),
    pageType: asEnum(r.pageType, PAGE_TYPES, 'pageType'),
    jobToBeDone: asString(r.jobToBeDone, 'jobToBeDone'),
    dna: normalizeDNA(r.dna),
    screenshotPath: asString(r.screenshotPath, 'screenshotPath'),
    aestheticVector: [...r.aestheticVector],
    eloRating: asFiniteNumber(r.eloRating, 'eloRating'),
  }
}

/** Boolean guard derived from the same validation path as `parseExemplar`. */
export function isExemplar(raw: unknown): raw is Exemplar {
  try {
    parseExemplar(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Serialise one `Exemplar` to a stable, human-reviewable JSON string (one record
 * per corpus file). Round-trips through `parseExemplar(JSON.parse(...))`.
 */
export function serializeExemplar(e: Exemplar): string {
  return `${JSON.stringify(e, null, 2)}\n`
}
