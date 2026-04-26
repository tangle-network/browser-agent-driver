/**
 * Layer 4 — Cross-tenant patch reliability aggregation.
 *
 * Groups PatchApplication records by patchHash and computes reliability
 * statistics. Fleet-mined patterns (Layer 5) consume these aggregates.
 */

import type { PatchApplication, PatchReliability } from './types.js'
import type { PatchRecommendation } from './types.js'

/** Stored record includes patchHash which is computed at write time by store.ts. */
type StoredApplication = PatchApplication & { patchHash?: string }

const MIN_APPLICATIONS_FOR_RECOMMENDED = 30
const MIN_TENANTS_FOR_RECOMMENDED = 5
const REPLICATION_RATE_THRESHOLD = 0.7
const MIN_APPLICATIONS_FOR_ANTIPATTERN = 10
const ANTIPATTERN_REPLICATION_THRESHOLD = 0.3

/**
 * A candidate application for aggregation — has both predicted and observed.
 */
type CompletedApplication = PatchApplication & {
  observed: NonNullable<PatchApplication['observed']>
}

function isCompleted(app: PatchApplication): app is CompletedApplication {
  return app.observed !== undefined
}

/**
 * True when the observed delta "replicates" the predicted: same sign and
 * at least half the magnitude.
 */
function replicates(predicted: { delta: number }, observed: { delta: number }): boolean {
  if (Math.sign(predicted.delta) !== Math.sign(observed.delta)) return false
  return Math.abs(observed.delta) >= 0.5 * Math.abs(predicted.delta)
}

/** Extract tenant tag from `appliedBy` field or application metadata. */
function tenantFrom(app: PatchApplication): string {
  // convention: 'agent:claude-code:tenant-id' or tenantId field if present
  const parts = app.appliedBy.split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : app.appliedBy
}

/**
 * Aggregate all PatchApplication records into per-patchHash reliability stats.
 * Records without an `observed` delta are counted in `applications` but excluded
 * from the rate computations.
 */
export function aggregatePatchReliability(
  applications: PatchApplication[],
): PatchReliability[] {
  const byHash = new Map<string, StoredApplication[]>()
  for (const app of applications as StoredApplication[]) {
    const hash = app.patchHash ?? app.patchId // fall back to patchId for records without hash
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash)!.push(app)
  }

  const results: PatchReliability[] = []
  for (const [hashKey, apps] of byHash.entries()) {
    const completed = apps.filter(isCompleted)
    const tenants = new Set(apps.map(tenantFrom)).size

    const meanPredictedDelta =
      completed.length > 0
        ? completed.reduce((s, a) => s + a.predicted.delta, 0) / completed.length
        : 0

    const meanObservedDelta =
      completed.length > 0
        ? completed.reduce((s, a) => s + a.observed.delta, 0) / completed.length
        : 0

    const replicationRate =
      completed.length > 0
        ? completed.filter(a => replicates(a.predicted, a.observed)).length / completed.length
        : 0

    results.push({
      patchHash: hashKey,
      applications: apps.length,
      meanPredictedDelta,
      meanObservedDelta,
      sampleTenants: tenants,
      replicationRate,
      recommendation: recommendationFor(apps.length, tenants, replicationRate, meanObservedDelta),
    })
  }

  return results.sort((a, b) => b.applications - a.applications)
}

export function recommendationFor(
  applications: number,
  sampleTenants: number,
  replicationRate: number,
  meanObservedDelta: number,
): PatchRecommendation {
  if (
    applications >= MIN_APPLICATIONS_FOR_RECOMMENDED &&
    sampleTenants >= MIN_TENANTS_FOR_RECOMMENDED &&
    replicationRate >= REPLICATION_RATE_THRESHOLD
  ) {
    return 'recommended'
  }
  if (
    applications >= MIN_APPLICATIONS_FOR_ANTIPATTERN &&
    replicationRate < ANTIPATTERN_REPLICATION_THRESHOLD &&
    meanObservedDelta < 0
  ) {
    return 'antipattern'
  }
  return 'neutral'
}
