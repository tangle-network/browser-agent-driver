import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsIntervention } from '../src/jobs/orchestrator.js'
import { runJob, type AuditFn } from '../src/jobs/queue.js'
import { createJob, loadJob } from '../src/jobs/index.js'
import type { Job, JobSpec } from '../src/jobs/index.js'

const SPEC: JobSpec = {
  kind: 'comparative-audit',
  discover: { source: 'list', urls: ['https://a/', 'https://b/', 'https://c/'] },
}

describe('needsIntervention', () => {
  function makeJob(results: Job['results']): Job {
    return {
      jobId: 'j', spec: SPEC, status: 'completed', createdAt: new Date().toISOString(),
      targets: SPEC.discover.urls.map(url => ({ url })), results, totalCostUSD: 0,
    }
  }

  it('returns false when every target succeeded', () => {
    expect(needsIntervention(makeJob([
      { url: 'https://a/', status: 'ok' }, { url: 'https://b/', status: 'ok' }, { url: 'https://c/', status: 'ok' },
    ]))).toBe(false)
  })

  it('returns false when every target ended ok or skipped', () => {
    expect(needsIntervention(makeJob([
      { url: 'https://a/', status: 'ok' }, { url: 'https://b/', status: 'skipped' }, { url: 'https://c/', status: 'ok' },
    ]))).toBe(false)
  })

  it('returns true when any target failed', () => {
    expect(needsIntervention(makeJob([
      { url: 'https://a/', status: 'ok' }, { url: 'https://b/', status: 'failed' }, { url: 'https://c/', status: 'ok' },
    ]))).toBe(true)
  })

  it('returns true when results are missing entries', () => {
    expect(needsIntervention(makeJob([{ url: 'https://a/', status: 'ok' }]))).toBe(true)
  })

  it('returns true for ok results that are zero-scored wayback snapshots', () => {
    const j: Job = {
      jobId: 'j', spec: SPEC, status: 'completed', createdAt: new Date().toISOString(),
      targets: [
        { url: 'https://a/', snapshotUrl: 'https://wb/a/2010', capturedAt: '2010-01-01T00:00:00Z' },
        { url: 'https://a/', snapshotUrl: 'https://wb/a/2020', capturedAt: '2020-01-01T00:00:00Z' },
      ],
      results: [
        { url: 'https://a/', snapshotUrl: 'https://wb/a/2010', status: 'ok', rollupScore: 0 },
        { url: 'https://a/', snapshotUrl: 'https://wb/a/2020', status: 'ok', rollupScore: 8 },
      ],
      totalCostUSD: 0,
    }
    expect(needsIntervention(j)).toBe(true)
  })

  it('does NOT trigger on zero-scored non-wayback (live audit) results', () => {
    // No snapshotUrl → live audit → zero score is genuine, not a capture artifact.
    const j: Job = {
      jobId: 'j', spec: SPEC, status: 'completed', createdAt: new Date().toISOString(),
      targets: [{ url: 'https://a/' }],
      results: [{ url: 'https://a/', status: 'ok', rollupScore: 0 }],
      totalCostUSD: 0,
    }
    expect(needsIntervention(j)).toBe(false)
  })
})

// Note: end-to-end LLM-driven orchestration is exercised by the smoke test
// in the working directory, not unit-tested here — we don't want a real LLM
// dependency in the test suite. The deterministic seam (needsIntervention)
// gates whether the LLM path is taken at all, and is fully tested above.

describe('queue resume + skipped surfacing (orchestrator-adjacent behavior)', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('runs only the missing targets when resume=true', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-orc-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    job.results.push({ url: 'https://a/', status: 'ok', runId: 'pre-a' })
    job.results.push({ url: 'https://b/', status: 'ok', runId: 'pre-b' })
    let calls = 0
    const auditFn: AuditFn = async (target) => {
      calls += 1
      return { runId: `r-${target.url}`, resultPath: '/x', rollupScore: 7 }
    }
    await runJob(job, { auditFn, dir, resume: true })
    expect(calls).toBe(1) // only c/ should be audited
    const reload = loadJob(job.jobId, dir)
    expect(reload?.results.filter(r => r.status === 'ok').length).toBe(3)
  })

  it('records blockedReason as skipped status in the job', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-orc-'))
    const job = createJob(SPEC, SPEC.discover.urls.map(url => ({ url })), dir)
    const auditFn: AuditFn = async (target) => ({
      runId: `r-${target.url}`, resultPath: '/x', rollupScore: 0,
      blockedReason: 'blocked: page title looks like an anti-bot challenge',
    })
    const final = await runJob(job, { auditFn, dir })
    expect(final.results.every(r => r.status === 'skipped')).toBe(true)
    expect(final.status).toBe('partial')
  })
})
