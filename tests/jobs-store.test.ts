import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newJobId, saveJob, loadJob, listJobs, appendIndexEntry, updateJobStatus } from '../src/jobs/store.js'
import type { Job } from '../src/jobs/types.js'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: newJobId(),
    spec: {
      kind: 'comparative-audit',
      discover: { source: 'list', urls: ['https://a.test', 'https://b.test'] },
    },
    status: 'queued',
    createdAt: new Date().toISOString(),
    targets: [{ url: 'https://a.test' }, { url: 'https://b.test' }],
    results: [],
    totalCostUSD: 0,
    ...overrides,
  }
}

describe('jobs store', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a job to disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    const job = makeJob()
    saveJob(job, dir)
    const loaded = loadJob(job.jobId, dir)
    expect(loaded).not.toBeNull()
    expect(loaded!.jobId).toBe(job.jobId)
    expect(loaded!.targets).toHaveLength(2)
  })

  it('returns null for an unknown job', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    expect(loadJob('does-not-exist', dir)).toBeNull()
  })

  it('writes atomically (no .tmp file lingers)', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    const job = makeJob()
    saveJob(job, dir)
    expect(existsSync(join(dir, `${job.jobId}.json`))).toBe(true)
    expect(existsSync(join(dir, `${job.jobId}.json.tmp`))).toBe(false)
  })

  it('lists jobs in newest-first order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    const a = makeJob({ createdAt: '2026-01-01T00:00:00.000Z' })
    const b = makeJob({ createdAt: '2026-02-01T00:00:00.000Z' })
    saveJob(a, dir); appendIndexEntry(a, dir)
    saveJob(b, dir); appendIndexEntry(b, dir)
    const list = listJobs(dir)
    expect(list[0].jobId).toBe(b.jobId)
    expect(list[1].jobId).toBe(a.jobId)
  })

  it('dedupes index entries by jobId, keeping the latest status', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    const j = makeJob()
    saveJob(j, dir); appendIndexEntry(j, dir)
    j.status = 'completed'
    saveJob(j, dir); appendIndexEntry(j, dir)
    const list = listJobs(dir)
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('completed')
  })

  it('updateJobStatus sets timestamps and persists', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-jobs-'))
    const j = makeJob()
    saveJob(j, dir); appendIndexEntry(j, dir)
    const running = updateJobStatus(j.jobId, 'running', dir)
    expect(running?.startedAt).toBeDefined()
    const done = updateJobStatus(j.jobId, 'completed', dir)
    expect(done?.completedAt).toBeDefined()
  })

  it('newJobId is unique across rapid invocations', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newJobId()))
    expect(ids.size).toBe(50)
  })
})
