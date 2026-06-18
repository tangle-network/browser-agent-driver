/**
 * Structural delta between two `DesignDNA`s — PURE, at DNA altitude only.
 *
 * `dnaDelta(current, target)` describes the transformation FROM the audited page
 * (`current`) TO a reference/winner (`target`): what the target adds, drops or
 * reshapes relative to the page. It diffs ONLY normalised `DesignDNA` fields
 * (colour roles, type scale, spacing rhythm, component economy) — it never diffs
 * raw `DesignTokens` (a different altitude owned by `compare.ts`). The result
 * grounds judge feedback and mints DNA-gap findings.
 *
 * No IO, no LLM; identical inputs always yield a deeply-equal delta.
 */

import type { DesignDNA, DnaDelta, ColorRole } from '../contracts.js'

const round2 = (n: number): number => Math.round(n * 100) / 100

const COLOR_ROLE_ORDER: ColorRole[] = ['primary', 'secondary', 'accent', 'neutral', 'background', 'border']

/** A colour role is "present" when it carries at least one hex. */
function presentRoles(dna: DesignDNA): Set<ColorRole> {
  const set = new Set<ColorRole>()
  for (const role of COLOR_ROLE_ORDER) {
    if (dna.color.roles[role].length > 0) set.add(role)
  }
  return set
}

/** Whether two role hex sets differ, order-independent. */
function hexSetChanged(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true
  const sb = new Set(b)
  return a.some((hex) => !sb.has(hex))
}

function diffColor(current: DesignDNA, target: DesignDNA): DnaDelta['color'] {
  const cur = presentRoles(current)
  const tgt = presentRoles(target)
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const role of COLOR_ROLE_ORDER) {
    const inCur = cur.has(role)
    const inTgt = tgt.has(role)
    if (inTgt && !inCur) added.push(role)
    else if (inCur && !inTgt) removed.push(role)
    else if (inCur && inTgt && hexSetChanged(current.color.roles[role], target.color.roles[role])) changed.push(role)
  }
  return { added, removed, changed }
}

function diffType(current: DesignDNA, target: DesignDNA): DnaDelta['type'] {
  const curSizes = new Set(current.type.steps.map((s) => s.fontSizePx))
  const tgtSizes = new Set(target.type.steps.map((s) => s.fontSizePx))
  let stepsAdded = 0
  let stepsRemoved = 0
  for (const size of tgtSizes) if (!curSizes.has(size)) stepsAdded++
  for (const size of curSizes) if (!tgtSizes.has(size)) stepsRemoved++
  let ratioDelta: number | undefined
  if (current.type.ratio !== undefined && target.type.ratio !== undefined) {
    const d = round2(target.type.ratio - current.type.ratio)
    ratioDelta = Math.abs(d) < 0.005 ? undefined : d
  }
  return { stepsAdded, stepsRemoved, ratioDelta }
}

function buildSummary(delta: DnaDelta): string {
  const parts: string[] = []
  if (delta.color.added.length) parts.push(`+${delta.color.added.length} colour role(s) (${delta.color.added.join(', ')})`)
  if (delta.color.removed.length) parts.push(`−${delta.color.removed.length} colour role(s) (${delta.color.removed.join(', ')})`)
  if (delta.color.changed.length) parts.push(`recoloured ${delta.color.changed.join(', ')}`)

  const stepBits: string[] = []
  if (delta.type.stepsAdded) stepBits.push(`+${delta.type.stepsAdded}`)
  if (delta.type.stepsRemoved) stepBits.push(`−${delta.type.stepsRemoved}`)
  if (stepBits.length) parts.push(`type scale ${stepBits.join('/')} step(s)`)
  if (delta.type.ratioDelta !== undefined) {
    parts.push(`scale ratio ${delta.type.ratioDelta > 0 ? '+' : ''}${delta.type.ratioDelta}`)
  }

  if (delta.spacing.baseUnitFrom !== delta.spacing.baseUnitTo) {
    parts.push(`grid ${delta.spacing.baseUnitFrom ?? 'none'}→${delta.spacing.baseUnitTo ?? 'none'}px`)
  }
  if (delta.spacing.densityChanged) parts.push('spacing density shift')

  const comp = delta.components
  const compBits: string[] = []
  for (const [kind, n] of Object.entries(comp) as [keyof DnaDelta['components'], number][]) {
    if (n !== 0) compBits.push(`${kind} ${n > 0 ? '+' : ''}${n}`)
  }
  if (compBits.length) parts.push(`components ${compBits.join(', ')}`)

  return parts.length ? parts.join('; ') : 'no structural difference'
}

/**
 * Compute the DNA-altitude delta from `current` (audited page) to `target`
 * (reference/winner). Component deltas are signed `target − current`: a NEGATIVE
 * value means the current page uses MORE of that pattern than the reference
 * (a consolidation opportunity); positive means fewer.
 */
export function dnaDelta(current: DesignDNA, target: DesignDNA): DnaDelta {
  const delta: DnaDelta = {
    color: diffColor(current, target),
    type: diffType(current, target),
    spacing: {
      baseUnitFrom: current.spacing.baseUnit,
      baseUnitTo: target.spacing.baseUnit,
      densityChanged: current.spacing.density !== target.spacing.density,
    },
    components: {
      buttons: target.components.buttons - current.components.buttons,
      inputs: target.components.inputs - current.components.inputs,
      cards: target.components.cards - current.components.cards,
      nav: target.components.nav - current.components.nav,
    },
    summary: '',
  }
  delta.summary = buildSummary(delta)
  return delta
}
