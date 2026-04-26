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
import { withRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry.js'

export interface AuditFn {
  (target: JobTarget, opts: Job['spec']['audit']): Promise<{
    runId: string
    resultPath: string
    rollupScore?: number
    pageType?: string
    costUSD?: number
    tokensPath?: string
    /**
     * When set, the result was deterministically classified as blocked /
     * anti-bot — the queue records `status: 'skipped'` with this reason
     * instead of `'ok'`, so leaderboards don't include a misleading score.
     */
    blockedReason?: string
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
  /** Retry policy applied around each `auditFn` call. Pass `null` to disable retry. */
  retryPolicy?: RetryPolicy | null
  /** When true, skip targets that already have a non-failed result on the job (used by `bad jobs resume`). */
  resume?: boolean
}

const DEFAULT_CONCURRENCY = 2

export async function runJob(job: Job, opts: RunJobOptions): Promise<Job> {
  const concurrency = opts.concurrency ?? job.spec.concurrency ?? DEFAULT_CONCURRENCY
  job.status = 'running'
  job.startedAt = job.startedAt ?? new Date().toISOString()
  saveJob(job, opts.dir)
  appendIndexEntry(job, opts.dir)

  // Resume support: skip targets that already have a non-failed result.
  const completed = new Set<string>()
  if (opts.resume) {
    for (const r of job.results) {
      if (r.status === 'ok' || r.status === 'skipped') completed.add(targetKey(r))
    }
  }
  const queue: JobTarget[] = job.targets.filter(t => !completed.has(targetKey(t)))
  let aborted = false

  async function worker(): Promise<void> {
    while (queue.length > 0 && !aborted) {
      const target = queue.shift()
      if (!target) break
      const entry = await runOne(target, job.spec.audit, opts.auditFn, opts.retryPolicy, opts.onError)
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
  retryPolicy: RetryPolicy | null | undefined,
  onError?: RunJobOptions['onError'],
): Promise<JobResultEntry | 'abort'> {
  try {
    const policy = retryPolicy === null ? undefined : (retryPolicy ?? DEFAULT_RETRY_POLICY)
    const call = () => auditFn(target, audit)
    const out = policy ? await withRetry(call, policy) : await call()
    if (out.blockedReason) {
      return {
        ...target,
        status: 'skipped',
        runId: out.runId,
        resultPath: out.resultPath,
        error: out.blockedReason,
        costUSD: out.costUSD,
      }
    }
    return {
      ...target,
      status: 'ok',
      runId: out.runId,
      resultPath: out.resultPath,
      rollupScore: out.rollupScore,
      pageType: out.pageType,
      costUSD: out.costUSD,
      tokensPath: out.tokensPath,
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

function targetKey(t: JobTarget): string {
  return t.snapshotUrl ?? t.url
}

function finalStatus(job: Job): Job['status'] {
  const total = job.results.length
  if (total === 0) return 'failed'
  const ok = job.results.filter(r => r.status === 'ok').length
  const failed = job.results.filter(r => r.status === 'failed').length
  // 'skipped' is a deterministic non-failure (e.g. anti-bot block detected).
  // Treat it as a clean outcome — we recorded the reason and moved on.
  if (ok === 0 && failed > 0) return 'failed'
  if (failed > 0 || ok < total) return 'partial'
  return 'completed'
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
