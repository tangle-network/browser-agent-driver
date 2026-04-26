import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJob } from '../src/jobs/queue.js'
import { saveJob, appendIndexEntry, loadJob } from '../src/jobs/store.js'
import { createJob } from '../src/jobs/index.js'
import type { Job, JobSpec, AuditFn } from '../src/jobs/index.js'

const SPEC: JobSpec = {
  kind: 'comparative-audit',
  discover: { source: 'list', urls: ['https://a.test', 'https://b.test', 'https://c.test'] },
  concurrency: 2,
}

describe('runJob', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('persists tokensPath when auditFn returns one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, [{ url: 'https://a.test' }], dir)
    const auditFn: AuditFn = async () => ({
      runId: 'run-a', resultPath: '/tmp/x/report.json', rollupScore: 7, tokensPath: '/tmp/x/tokens.json',
    })
    const final = await runJob(job, { auditFn, dir })
    expect(final.results[0].tokensPath).toBe('/tmp/x/tokens.json')
  })

  it('runs every target and marks the job completed when all succeed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    const auditFn: AuditFn = async (target) => ({
      runId: `run-${target.url}`,
      resultPath: `/tmp/${target.url}/report.json`,
      rollupScore: 7,
      pageType: 'saas-app',
      costUSD: 0.4,
    })
    const final = await runJob(job, { auditFn, dir })
    expect(final.status).toBe('completed')
    expect(final.results).toHaveLength(3)
    expect(final.results.every(r => r.status === 'ok')).toBe(true)
    expect(final.totalCostUSD).toBeCloseTo(1.2)
  })

  it('marks the job partial when some targets fail', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    let i = 0
    const auditFn: AuditFn = async (target) => {
      i += 1
      if (i === 2) throw new Error('synthetic failure')
      return { runId: `run-${i}`, resultPath: '/tmp/x/report.json', rollupScore: 6, costUSD: 0.4 }
    }
    const final = await runJob(job, { auditFn, dir })
    expect(final.status).toBe('partial')
    expect(final.results.filter(r => r.status === 'ok')).toHaveLength(2)
    expect(final.results.filter(r => r.status === 'failed')).toHaveLength(1)
  })

  it('marks the job failed when every target fails', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    const auditFn: AuditFn = async () => { throw new Error('always') }
    const final = await runJob(job, { auditFn, dir })
    expect(final.status).toBe('failed')
  })

  it('persists each result as it lands (crash-safe)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    const seen: number[] = []
    const auditFn: AuditFn = async (target) => {
      // After each result, the on-disk job should reflect the new entry.
      const persisted = loadJob(job.jobId, dir)!
      seen.push(persisted.results.length)
      return { runId: target.url, resultPath: `/tmp/${target.url}/report.json`, rollupScore: 5 }
    }
    await runJob(job, { auditFn, dir, concurrency: 1 })
    expect(seen).toEqual([0, 1, 2])
  })

  it('respects onError abort', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    const auditFn: AuditFn = async () => { throw new Error('boom') }
    const final = await runJob(job, { auditFn, dir, concurrency: 1, onError: () => 'abort' })
    expect(final.status).toBe('cancelled')
    expect(final.results.length).toBeLessThan(3)
  })
})

describe('createJob', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('mints a queued job and writes index entry', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-q-'))
    const job = createJob(SPEC, [{ url: 'https://a.test' }], dir)
    expect(job.status).toBe('queued')
    const reload = loadJob(job.jobId, dir)
    expect(reload?.targets).toHaveLength(1)
  })
})
