/**
 * Adaptive cost estimate from historical jobs. The default flat
 * `DEFAULT_PER_AUDIT_USD` is still a fine starting point for a fresh user,
 * but once 3+ jobs have completed we can do better: averaging the actual
 * per-target cost across recent jobs is closer to ground truth, especially
 * once ethics / first-principles modes start firing differently per target.
 *
 * Pure function of `~/.bad/jobs/` records — no telemetry endpoint required.
 */

import type { JobIndexEntry } from './store.js'
import { listJobs, loadJob } from './store.js'
import { DEFAULT_PER_AUDIT_USD } from './cost-estimate.js'

/** Min number of completed jobs before we trust history over the static default. */
const MIN_HISTORY = 3

export interface AdaptiveCostStats {
  perAuditUSD: number
  source: 'history' | 'default'
  /** Number of historical job records the estimate was averaged over. */
  jobsObserved: number
  /** Number of audited targets the estimate was averaged over. */
  targetsObserved: number
}

export function computePerAuditFromHistory(dir?: string): AdaptiveCostStats {
  const entries = listJobs(dir)
  // Only count completed/partial jobs — failed ones have skewed cost.
  const usable = entries.filter((e: JobIndexEntry) => e.status === 'completed' || e.status === 'partial').slice(0, 20)
  if (usable.length < MIN_HISTORY) {
    return { perAuditUSD: DEFAULT_PER_AUDIT_USD, source: 'default', jobsObserved: usable.length, targetsObserved: 0 }
  }
  let totalCost = 0
  let totalTargets = 0
  for (const entry of usable) {
    const job = loadJob(entry.jobId, dir)
    if (!job) continue
    const okCount = job.results.filter(r => r.status === 'ok' && typeof r.costUSD === 'number').length
    if (okCount === 0) continue
    totalCost += job.totalCostUSD
    totalTargets += okCount
  }
  if (totalTargets === 0) {
    return { perAuditUSD: DEFAULT_PER_AUDIT_USD, source: 'default', jobsObserved: usable.length, targetsObserved: 0 }
  }
  const perAudit = totalCost / totalTargets
  // Floor at half the static default to prevent runaway optimism on a stretch
  // of zero-cost jobs (which can happen with the claude-code provider).
  const floored = Math.max(perAudit, DEFAULT_PER_AUDIT_USD * 0.5)
  return { perAuditUSD: floored, source: 'history', jobsObserved: usable.length, targetsObserved: totalTargets }
}
