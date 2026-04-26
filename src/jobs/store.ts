/**
 * Job store — whole-file JSON per job + an append-only index for listing.
 *
 * Layout:
 *   ~/.bad/jobs/<jobId>.json      — Job record (atomic write via tmp + rename)
 *   ~/.bad/jobs/index.jsonl       — append-only one line per job ({jobId, status, createdAt, label})
 *
 * Whole-file rewrite is intentional: a job is a single coherent record with
 * monotonically-extending `results[]`. Append-only at the entry level would
 * duplicate target rows; append-only at the file level would force readers
 * to fold N updates into one logical record. Atomic rename gives us crash
 * safety without that complexity.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Job, JobStatus } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), '.bad', 'jobs')

export function jobsDir(override?: string): string {
  return override ?? DEFAULT_DIR
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

export function jobPath(jobId: string, dir?: string): string {
  return path.join(jobsDir(dir), `${jobId}.json`)
}

function indexPath(dir?: string): string {
  return path.join(jobsDir(dir), 'index.jsonl')
}

export function newJobId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15) // YYYYMMDDTHHMMSS
  const rand = Math.random().toString(36).slice(2, 8)
  return `job_${stamp}_${rand}`
}

export function saveJob(job: Job, dir?: string): void {
  const target = jobPath(job.jobId, dir)
  ensureDir(path.dirname(target))
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2))
  fs.renameSync(tmp, target)
}

export function loadJob(jobId: string, dir?: string): Job | null {
  const target = jobPath(jobId, dir)
  if (!fs.existsSync(target)) return null
  return JSON.parse(fs.readFileSync(target, 'utf-8')) as Job
}

export function appendIndexEntry(job: Job, dir?: string): void {
  const file = indexPath(dir)
  ensureDir(path.dirname(file))
  const line = JSON.stringify({
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    label: job.spec.label ?? null,
    targetCount: job.targets.length,
  })
  fs.appendFileSync(file, line + '\n')
}

export interface JobIndexEntry {
  jobId: string
  status: JobStatus
  createdAt: string
  label: string | null
  targetCount: number
}

/** Reads the index file. Later entries for the same jobId override earlier ones. */
export function listJobs(dir?: string): JobIndexEntry[] {
  const file = indexPath(dir)
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const map = new Map<string, JobIndexEntry>()
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JobIndexEntry
      map.set(entry.jobId, entry)
    } catch {
      // Skip malformed lines — index is best-effort.
    }
  }
  return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function updateJobStatus(jobId: string, status: JobStatus, dir?: string): Job | null {
  const job = loadJob(jobId, dir)
  if (!job) return null
  job.status = status
  if (status === 'running' && !job.startedAt) job.startedAt = new Date().toISOString()
  if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'partial') {
    job.completedAt = new Date().toISOString()
  }
  saveJob(job, dir)
  appendIndexEntry(job, dir)
  return job
}
