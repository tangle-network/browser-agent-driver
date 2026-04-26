/**
 * Job runner — bounded-concurrency fan-out over the audit pipeline.
 *
 * Synchronous in the sense that `runJob()` returns when every target has been
 * processed (ok, failed, or skipped). Crash safety: every individual result
 * is persisted to disk as soon as it lands, so killing the process leaves a
 * resumable record (resume is a future addition; today the partial state
 * is just observable).
 *
 * `auditFn` is injected so tests can run the queue without touching
 * Playwright/LLMs.
 */

import { saveJob, appendIndexEntry } from './store.js'
import type { Job, JobResultEntry, JobTarget } from './types.js'

export interface AuditFn {
  (target: JobTarget, opts: Job['spec']['audit']): Promise<{
    runId: string
    resultPath: string
    rollupScore?: number
    pageType?: string
    costUSD?: number
  }>
}

export interface RunJobOptions {
  auditFn: AuditFn
  /** Persistence dir override (tests). */
  dir?: string
  /** Concurrency override; falls back to spec.concurrency, then 2. */
  concurrency?: number
  /** Per-target failure swallower — defaults to recording the error and continuing. */
  onError?: (target: JobTarget, error: Error) => 'continue' | 'abort'
}

const DEFAULT_CONCURRENCY = 2

export async function runJob(job: Job, opts: RunJobOptions): Promise<Job> {
  const concurrency = opts.concurrency ?? job.spec.concurrency ?? DEFAULT_CONCURRENCY
  job.status = 'running'
  job.startedAt = job.startedAt ?? new Date().toISOString()
  saveJob(job, opts.dir)
  appendIndexEntry(job, opts.dir)

  const queue: JobTarget[] = [...job.targets]
  let aborted = false

  async function worker(): Promise<void> {
    while (queue.length > 0 && !aborted) {
      const target = queue.shift()
      if (!target) break
      const entry = await runOne(target, job.spec.audit, opts.auditFn, opts.onError)
      if (entry === 'abort') {
        aborted = true
        return
      }
      job.results.push(entry)
      if (entry.costUSD) job.totalCostUSD = round2(job.totalCostUSD + entry.costUSD)
      saveJob(job, opts.dir)
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  job.completedAt = new Date().toISOString()
  job.status = aborted ? 'cancelled' : finalStatus(job)
  saveJob(job, opts.dir)
  appendIndexEntry(job, opts.dir)
  return job
}

async function runOne(
  target: JobTarget,
  audit: Job['spec']['audit'],
  auditFn: AuditFn,
  onError?: RunJobOptions['onError'],
): Promise<JobResultEntry | 'abort'> {
  try {
    const out = await auditFn(target, audit)
    return {
      ...target,
      status: 'ok',
      runId: out.runId,
      resultPath: out.resultPath,
      rollupScore: out.rollupScore,
      pageType: out.pageType,
      costUSD: out.costUSD,
    }
  } catch (err) {
    const error = err as Error
    const decision = onError?.(target, error) ?? 'continue'
    if (decision === 'abort') return 'abort'
    return {
      ...target,
      status: 'failed',
      error: error.message,
    }
  }
}

function finalStatus(job: Job): Job['status'] {
  const total = job.results.length
  if (total === 0) return 'failed'
  const ok = job.results.filter(r => r.status === 'ok').length
  if (ok === 0) return 'failed'
  if (ok < total) return 'partial'
  return 'completed'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
