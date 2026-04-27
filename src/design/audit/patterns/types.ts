/**
 * Layer 5 — Pattern library type contract.
 *
 * Patterns are mined from accumulated PatchApplication data once a cluster
 * meets: N≥30 applications across ≥5 distinct tenants, replicationRate≥0.7.
 * Until fleet data accumulates (≥6 weeks), the pattern library is empty.
 *
 * This module defines the stable query API so agents can code against it now.
 * The mining and matching implementations are scaffolded; real clustering runs
 * as a Cloudflare Worker cron once the attribution data accumulates.
 */

export type { PageType, Dimension } from '../score-types.js'
import type { PageType, Dimension } from '../score-types.js'

export interface PatternScaffold {
  description: string
  referenceTsx?: string
  referenceCss?: string
  keyDecisions: string[]
}

export interface PatternFleetEvidence {
  applications: number
  successRate: number
  medianDimDelta: Record<Dimension, number>
  sampleTenants: number
}

export interface Pattern {
  patternId: string
  category: string
  classification: { type: PageType; tags: string[] }
  scaffold: PatternScaffold
  scores: { whenFollowed: Record<Dimension, number> }
  fleetEvidence: PatternFleetEvidence
  fixtures: string[]
}

export interface PatternQuery {
  category?: string
  pageType?: PageType
  weakDimension?: Dimension
  minApplications?: number
  minSuccessRate?: number
}

export interface PatternMatch {
  pattern: Pattern
  matchConfidence: number
  expectedDelta: Record<Dimension, number>
  applicationGuidance: string
}
