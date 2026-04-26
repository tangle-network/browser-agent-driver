import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePerAuditFromHistory } from '../src/jobs/cost-history.js'
import { saveJob, appendIndexEntry } from '../src/jobs/store.js'
import { DEFAULT_PER_AUDIT_USD } from '../src/jobs/cost-estimate.js'
import type { Job } from '../src/jobs/types.js'

function jobWith(jobId: string, status: Job['status'], totalCostUSD: number, okTargetsWithCost: number): Job {
  const results: Job['results'] = Array.from({ length: okTargetsWithCost }, (_, i) => ({
    url: `https://x${i}/`, status: 'ok' as const, runId: `run-${i}`, costUSD: totalCostUSD / okTargetsWithCost,
  }))
  return {
    jobId,
    spec: { kind: 'comparative-audit', discover: { source: 'list', urls: results.map(r => r.url) } },
    status,
    createdAt: new Date(Date.now() - Math.random() * 1000).toISOString(),
    targets: results.map(r => ({ url: r.url })),
    results,
    totalCostUSD,
  }
}

describe('computePerAuditFromHistory', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('returns the static default when no history exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-cost-'))
    const stats = computePerAuditFromHistory(dir)
    expect(stats.source).toBe('default')
    expect(stats.perAuditUSD).toBe(DEFAULT_PER_AUDIT_USD)
  })

  it('returns the static default when fewer than 3 historical jobs exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-cost-'))
    const j1 = jobWith('a', 'completed', 0.6, 2)
    const j2 = jobWith('b', 'completed', 0.6, 2)
    saveJob(j1, dir); appendIndexEntry(j1, dir)
    saveJob(j2, dir); appendIndexEntry(j2, dir)
    expect(computePerAuditFromHistory(dir).source).toBe('default')
  })

  it('uses history when 3+ completed jobs exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-cost-'))
    for (let i = 0; i < 4; i++) {
      const j = jobWith(`j${i}`, 'completed', 0.5, 5) // 0.10/audit
      saveJob(j, dir); appendIndexEntry(j, dir)
    }
    const stats = computePerAuditFromHistory(dir)
    expect(stats.source).toBe('history')
    expect(stats.perAuditUSD).toBeGreaterThanOrEqual(DEFAULT_PER_AUDIT_USD * 0.5) // floored
    expect(stats.targetsObserved).toBe(20)
  })

  it('floors at 50% of static default to prevent runaway optimism', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-cost-'))
    for (let i = 0; i < 5; i++) {
      // jobs with totalCost=0 (claude-code free) — without floor we'd estimate $0
      const j = jobWith(`j${i}`, 'completed', 0, 5)
      saveJob(j, dir); appendIndexEntry(j, dir)
    }
    const stats = computePerAuditFromHistory(dir)
    expect(stats.perAuditUSD).toBe(DEFAULT_PER_AUDIT_USD * 0.5)
  })

  it('ignores failed jobs', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-cost-'))
    for (let i = 0; i < 3; i++) {
      const j = jobWith(`f${i}`, 'failed', 9, 0) // skewed cost, no ok targets
      saveJob(j, dir); appendIndexEntry(j, dir)
    }
    expect(computePerAuditFromHistory(dir).source).toBe('default')
  })
})
