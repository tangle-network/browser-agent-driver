/**
 * Pre-flight cost estimate — refuses to silently spend $1k.
 *
 * The numbers here are deliberately conservative and based on observed
 * production telemetry for `claude-code` provider with sonnet at the time of
 * writing. If the assumptions drift, only one constant changes.
 */

import type { CostEstimate, JobSpec } from './types.js'

/** Average USD per single-page audit. Tuned for sonnet via claude-code provider, 1 audit pass. */
export const DEFAULT_PER_AUDIT_USD = 0.4

export function estimateCost(spec: JobSpec, targetCount: number, perAuditUSD = DEFAULT_PER_AUDIT_USD): CostEstimate {
  const pages = Math.max(spec.audit?.pages ?? 1, 1)
  const estimatedTotalUSD = targetCount * pages * perAuditUSD
  const exceedsCap = typeof spec.maxCostUSD === 'number' && estimatedTotalUSD > spec.maxCostUSD
  return {
    targetCount,
    perAuditUSD: perAuditUSD * pages,
    estimatedTotalUSD,
    exceedsCap,
  }
}
