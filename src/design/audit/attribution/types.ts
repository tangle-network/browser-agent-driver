/**
 * Layer 4 — Outcome attribution type contract.
 *
 * These types are already defined in src/design/audit/score-types.ts as part of
 * the Phase 0 contract. This module re-exports them so attribution code can
 * import from a single, predictable path. When score-types.ts is the sole
 * canonical source, update these re-exports accordingly.
 */

export type {
  PatchApplication,
  PatchReliability,
} from '../score-types.js'

/** sha256(diff.before + '\n---\n' + diff.after + '\n---\n' + scope).slice(0,16) */
export type PatchHash = string

export type PatchRecommendation = 'recommended' | 'neutral' | 'antipattern'
