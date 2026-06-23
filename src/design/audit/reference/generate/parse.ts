/**
 * Redesign-direction parser — a PURE core of the generative layer.
 *
 * `parseDirection` turns one raw model response into a typed `RedesignDirection`
 * or a typed `DirectionParseError`. It is FAIL-CLOSED by construction: malformed
 * JSON, a missing/ill-typed field, an ungrounded direction, or a hallucinated
 * exemplar id all yield an explicit error — never a fabricated or half-built
 * direction. The generator drops errored calls rather than inventing content.
 *
 * Hostile-input safe: the response is parsed with `JSON.parse` only (no eval),
 * and the returned direction is assembled FIELD-BY-FIELD from validated values,
 * so unexpected keys (including `__proto__`) never leak into the result and no
 * prototype is mutated.
 *
 * No IO, no LLM, no browser — unit-tested on string fixtures alone.
 */

import type {
  RedesignDirection,
  DirectionParseResult,
  TypeSystemSpec,
  ColorSystemSpec,
  MotionSpec,
  CopyRevision,
} from '../contracts.js'

const fail = (reason: string): DirectionParseResult => ({ ok: false, reason })

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isString = (v: unknown): v is string => typeof v === 'string'

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)

/**
 * Coerce a numeric value, tolerating the numeric STRINGS many models emit
 * (`"1.25"`, `"16px"`). Same value, just typed — no fabrication. Returns
 * undefined when there's no leading finite number to read.
 */
const coerceNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') {
    const n = Number.parseFloat(v.trim())
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Coerce an array of numbers, accepting numeric strings per element.
 *  Returns undefined if the input isn't an array or any element won't coerce. */
const coerceNumberArray = (v: unknown): number[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: number[] = []
  for (const x of v) {
    const n = coerceNumber(x)
    if (n === undefined) return undefined
    out.push(n)
  }
  return out
}

/**
 * Pull the outermost JSON object out of a model response. Tolerates a leading
 * markdown fence and any prose preamble/suffix the gateway wraps around the
 * object. Distinguishes three cases so the caller can report each truthfully:
 *   - `{ json }`       — an object literal was found;
 *   - `{ truncated }`  — an object was OPENED (`{`) but never closed (`}`), i.e.
 *                        the model ran out of output budget mid-object;
 *   - `null`           — no object literal at all (empty or non-JSON output).
 */
function extractJsonObject(raw: string): { json: string } | { truncated: true } | null {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  const first = text.indexOf('{')
  if (first < 0) return null
  const last = text.lastIndexOf('}')
  if (last <= first) return { truncated: true }
  return { json: text.slice(first, last + 1) }
}

function parseTypeSystem(raw: unknown): TypeSystemSpec | string {
  if (!isRecord(raw)) return 'typeSystem must be an object'
  if (!isStringArray(raw.families) || raw.families.length === 0) return 'typeSystem.families must be a non-empty string[]'
  const scalePx = coerceNumberArray(raw.scalePx)
  if (!scalePx || scalePx.length === 0) return 'typeSystem.scalePx must be a non-empty number[]'
  const ratio = coerceNumber(raw.ratio)
  if (ratio === undefined) return 'typeSystem.ratio must be a number'
  if (!isString(raw.rationale)) return 'typeSystem.rationale must be a string'
  return { families: raw.families, scalePx, ratio, rationale: raw.rationale }
}

function parseColorSystem(raw: unknown): ColorSystemSpec | string {
  if (!isRecord(raw)) return 'colorSystem must be an object'
  if (!isString(raw.primary)) return 'colorSystem.primary must be a string'
  if (!isStringArray(raw.neutrals)) return 'colorSystem.neutrals must be a string[]'
  if (!isString(raw.background)) return 'colorSystem.background must be a string'
  if (!isString(raw.rationale)) return 'colorSystem.rationale must be a string'
  if (raw.accent !== undefined && !isString(raw.accent)) return 'colorSystem.accent must be a string when present'
  const spec: ColorSystemSpec = {
    primary: raw.primary,
    neutrals: raw.neutrals,
    background: raw.background,
    rationale: raw.rationale,
  }
  if (isString(raw.accent)) spec.accent = raw.accent
  return spec
}

function parseMotionSpec(raw: unknown): MotionSpec | string {
  if (!isRecord(raw)) return 'motionSpec must be an object'
  const durationsMs = coerceNumberArray(raw.durationsMs)
  if (!durationsMs) return 'motionSpec.durationsMs must be a number[]'
  if (!isStringArray(raw.easings)) return 'motionSpec.easings must be a string[]'
  if (!isStringArray(raw.cues)) return 'motionSpec.cues must be a string[]'
  return { durationsMs, easings: raw.easings, cues: raw.cues }
}

function parseCopy(raw: unknown): CopyRevision[] | string {
  if (!Array.isArray(raw)) return 'copy must be an array'
  const out: CopyRevision[] = []
  for (const item of raw) {
    if (!isRecord(item)) return 'each copy entry must be an object'
    if (!isString(item.location)) return 'copy[].location must be a string'
    if (!isString(item.after)) return 'copy[].after must be a string'
    if (item.before !== undefined && !isString(item.before)) return 'copy[].before must be a string when present'
    const rev: CopyRevision = { location: item.location, after: item.after }
    if (isString(item.before)) rev.before = item.before
    out.push(rev)
  }
  return out
}

/**
 * Ids in `d.groundedInExemplarIds` that are NOT in `allowedIds` (the retrieved
 * set). Empty ⇒ the direction is grounded only in real, retrieved exemplars.
 */
export function validateGrounding(d: RedesignDirection, allowedIds: string[]): string[] {
  const allowed = new Set(allowedIds)
  return d.groundedInExemplarIds.filter((id) => !allowed.has(id))
}

/**
 * Parse one model response into a `RedesignDirection`. Fail-closed: any defect
 * returns a `DirectionParseError`, never a partial or invented direction.
 */
export function parseDirection(raw: string, allowedIds: string[]): DirectionParseResult {
  const extracted = extractJsonObject(raw)
  if (extracted === null) {
    return fail(raw.trim().length === 0 ? 'model returned empty output' : 'no JSON object found in model output')
  }
  if ('truncated' in extracted) {
    return fail('model output truncated — incomplete JSON object (raise the generation token budget for reasoning models)')
  }
  const json = extracted.json

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return fail(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!isRecord(parsed)) return fail('parsed value is not an object')

  if (!isString(parsed.id)) return fail('missing or invalid field: id')
  if (!isString(parsed.name)) return fail('missing or invalid field: name')
  if (!isString(parsed.rationale)) return fail('missing or invalid field: rationale')
  if (!isString(parsed.asciiLayout)) return fail('missing or invalid field: asciiLayout')
  if (!isStringArray(parsed.hierarchy) || parsed.hierarchy.length === 0) {
    return fail('hierarchy must be a non-empty string[]')
  }
  if (!isStringArray(parsed.groundedInExemplarIds)) {
    return fail('missing or invalid field: groundedInExemplarIds')
  }

  const typeSystem = parseTypeSystem(parsed.typeSystem)
  if (typeof typeSystem === 'string') return fail(typeSystem)
  const colorSystem = parseColorSystem(parsed.colorSystem)
  if (typeof colorSystem === 'string') return fail(colorSystem)
  const motionSpec = parseMotionSpec(parsed.motionSpec)
  if (typeof motionSpec === 'string') return fail(motionSpec)
  const copy = parseCopy(parsed.copy)
  if (typeof copy === 'string') return fail(copy)

  // Assemble field-by-field — never spread `parsed` — so no unexpected key
  // (e.g. `__proto__`) survives into the result.
  const direction: RedesignDirection = {
    id: parsed.id,
    name: parsed.name,
    rationale: parsed.rationale,
    asciiLayout: parsed.asciiLayout,
    typeSystem,
    colorSystem,
    motionSpec,
    hierarchy: parsed.hierarchy,
    copy,
    groundedInExemplarIds: parsed.groundedInExemplarIds,
  }

  if (direction.groundedInExemplarIds.length === 0) {
    return fail('direction is ungrounded (empty groundedInExemplarIds)')
  }
  const offenders = validateGrounding(direction, allowedIds)
  if (offenders.length > 0) {
    return fail(`grounded in unknown exemplar ids: ${offenders.join(', ')}`)
  }

  return { ok: true, direction }
}
