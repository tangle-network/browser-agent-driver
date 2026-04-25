/**
 * Pareto front utilities for the GEPA loop.
 *
 * Mirrors the shape of agent-eval's `paretoFrontier` so this module can be
 * upstreamed verbatim once we're happy with the API. Direction-annotated:
 * each axis says whether higher or lower is better.
 */

import type { ObjectiveVector } from './types.js'

export type Direction = 'maximize' | 'minimize'

export const OBJECTIVE_DIRECTIONS: Record<keyof ObjectiveVector, Direction> = {
  recall: 'maximize',
  precision: 'maximize',
  passOrthogonality: 'maximize',
  scoreStability: 'maximize',
  cost: 'minimize',
}

export function dominates(a: ObjectiveVector, b: ObjectiveVector): boolean {
  let strictlyBetter = false
  for (const key of Object.keys(OBJECTIVE_DIRECTIONS) as Array<keyof ObjectiveVector>) {
    const dir = OBJECTIVE_DIRECTIONS[key]
    const av = a[key]
    const bv = b[key]
    if (dir === 'maximize') {
      if (av < bv) return false
      if (av > bv) strictlyBetter = true
    } else {
      if (av > bv) return false
      if (av < bv) strictlyBetter = true
    }
  }
  return strictlyBetter
}

export interface ParetoCandidate<T> {
  item: T
  vector: ObjectiveVector
}

export function paretoFront<T>(candidates: Array<ParetoCandidate<T>>): Array<ParetoCandidate<T>> {
  const front: Array<ParetoCandidate<T>> = []
  for (const candidate of candidates) {
    let dominated = false
    for (const other of candidates) {
      if (other === candidate) continue
      if (dominates(other.vector, candidate.vector)) {
        dominated = true
        break
      }
    }
    if (!dominated) front.push(candidate)
  }
  return front
}

/**
 * Single-scalar fallback: weighted sum on a fixed axis order. Used when a
 * caller wants ONE winner per generation (e.g. for a default selection),
 * not when reporting the Pareto frontier.
 *
 * Default weights bias toward recall — the design-audit's job is to find
 * defects; precision and orthogonality are tie-breakers.
 */
export const DEFAULT_SCALAR_WEIGHTS: Record<keyof ObjectiveVector, number> = {
  recall: 0.45,
  precision: 0.2,
  passOrthogonality: 0.15,
  scoreStability: 0.1,
  cost: 0.1,
}

export function scalarScore(
  v: ObjectiveVector,
  weights: Record<keyof ObjectiveVector, number> = DEFAULT_SCALAR_WEIGHTS,
  costScale = 10_000,
): number {
  const costAxis = Math.max(0, 1 - v.cost / costScale)
  return (
    v.recall * weights.recall +
    v.precision * weights.precision +
    v.passOrthogonality * weights.passOrthogonality +
    v.scoreStability * weights.scoreStability +
    costAxis * weights.cost
  )
}
