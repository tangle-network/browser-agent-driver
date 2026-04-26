/**
 * Jobs — declarative comparative-audit jobs.
 *
 * Public surface:
 *   createJob(spec) → Job (queued, persisted, ready to run)
 *   runJob(job, opts) → Job (executes the fan-out, returns final state)
 *   loadJob / listJobs / saveJob — store accessors
 *   estimateCost — pre-flight cost guard
 */

export type {
  Job,
  JobSpec,
  JobStatus,
  JobKind,
  JobTarget,
  JobResultEntry,
  JobResultStatus,
  DiscoverSpec,
  DiscoverSource,
  AuditOptions,
  CostEstimate,
} from './types.js'

export { newJobId, saveJob, loadJob, listJobs, appendIndexEntry, jobsDir, jobPath, updateJobStatus } from './store.js'
export type { JobIndexEntry } from './store.js'
export { estimateCost, DEFAULT_PER_AUDIT_USD } from './cost-estimate.js'
export { runJob } from './queue.js'
export type { AuditFn, RunJobOptions } from './queue.js'
export { withRetry, isRetryableDefault, DEFAULT_RETRY_POLICY } from './retry.js'
export type { RetryPolicy } from './retry.js'
export { detectBlock, reasonFor } from './anti-bot.js'
export type { BlockSignals } from './anti-bot.js'
export { computePerAuditFromHistory } from './cost-history.js'
export type { AdaptiveCostStats } from './cost-history.js'
export { orchestrateJob, needsIntervention } from './orchestrator.js'
export type { OrchestrateJobOptions } from './orchestrator.js'

import type { Job, JobSpec, JobTarget } from './types.js'
import { newJobId, saveJob, appendIndexEntry } from './store.js'

/**
 * Mint a fresh `queued` job from a spec. Targets are seeded from the spec
 * (snapshot expansion, if any, must be done by the caller via the
 * `discover` module before runJob).
 */
export function createJob(spec: JobSpec, targets: JobTarget[], dir?: string): Job {
  const job: Job = {
    jobId: newJobId(),
    spec,
    status: 'queued',
    createdAt: new Date().toISOString(),
    targets,
    results: [],
    totalCostUSD: 0,
  }
  saveJob(job, dir)
  appendIndexEntry(job, dir)
  return job
}
