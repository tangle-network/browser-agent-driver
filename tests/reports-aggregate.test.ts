import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateJob, leaderboard, longitudinalFor, compareRuns, tierBuckets } from '../src/reports/aggregate.js'
import type { Job } from '../src/jobs/types.js'

function writeReport(dir: string, runId: string, payload: object): string {
  const runDir = join(dir, runId)
  mkdirSync(runDir, { recursive: true })
  const file = join(runDir, 'report.json')
  writeFileSync(file, JSON.stringify(payload))
  return file
}

function makeJob(results: Job['results']): Job {
  return {
    jobId: 'test-job',
    spec: { kind: 'comparative-audit', discover: { source: 'list', urls: results.map(r => r.url) } },
    status: 'completed',
    createdAt: new Date().toISOString(),
    targets: results.map(r => ({ url: r.url, snapshotUrl: r.snapshotUrl, capturedAt: r.capturedAt })),
    results,
    totalCostUSD: 0,
  }
}

describe('aggregateJob', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('reads each ok result\'s report.json and projects to AggregateRow', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-agg-'))
    const a = writeReport(dir, 'run-a', {
      pages: [{
        auditResult: {
          classification: { type: 'saas-app', domain: 'fintech' },
          rollup: { score: 7.5 },
          scores: { product_intent: { score: 8 }, visual_craft: { score: 7 } },
        },
        ethicsViolations: [],
      }],
    })
    const job = makeJob([
      { url: 'https://a/', status: 'ok', runId: 'run-a', resultPath: a, rollupScore: 7.5, pageType: 'saas-app' },
      { url: 'https://b/', status: 'failed', error: 'boom' },
    ])
    const rows = aggregateJob(job)
    expect(rows).toHaveLength(2)
    expect(rows[0].rollupScore).toBe(7.5)
    expect(rows[0].pageType).toBe('saas-app')
    expect(rows[0].domain).toBe('fintech')
    expect(rows[0].dimensions.product_intent).toBe(8)
    expect(Number.isNaN(rows[1].rollupScore)).toBe(true)
  })

  it('falls back to v1 fields when auditResult is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-agg-'))
    const a = writeReport(dir, 'run-a', {
      pages: [{ score: 6.2, classification: { type: 'marketing' } }],
    })
    const job = makeJob([{ url: 'https://a/', status: 'ok', runId: 'run-a', resultPath: a, rollupScore: 6.2 }])
    const rows = aggregateJob(job)
    expect(rows[0].rollupScore).toBe(6.2)
    expect(rows[0].pageType).toBe('marketing')
  })

  it('does not crash when report.json is missing on disk', () => {
    const job = makeJob([{ url: 'https://gone/', status: 'ok', runId: 'run-x', resultPath: '/nope/report.json', rollupScore: 4 }])
    const rows = aggregateJob(job)
    expect(rows).toHaveLength(1)
    // resultPath missing → row has the JobResultEntry-level rollupScore but no auditResult enrichment.
    expect(rows[0].rollupScore).toBe(4)
  })
})

describe('leaderboard', () => {
  it('sorts desc by rollupScore and applies topN', () => {
    const rows = [
      { url: 'a', runId: '1', rollupScore: 5, dimensions: {}, ethicsViolations: 0 },
      { url: 'b', runId: '2', rollupScore: 9, dimensions: {}, ethicsViolations: 0 },
      { url: 'c', runId: '3', rollupScore: 7, dimensions: {}, ethicsViolations: 0 },
    ]
    const top2 = leaderboard(rows, { topN: 2 })
    expect(top2.map(r => r.url)).toEqual(['b', 'c'])
  })

  it('filters by pageType', () => {
    const rows = [
      { url: 'a', runId: '1', rollupScore: 9, dimensions: {}, ethicsViolations: 0, pageType: 'saas-app' },
      { url: 'b', runId: '2', rollupScore: 8, dimensions: {}, ethicsViolations: 0, pageType: 'marketing' },
    ]
    const filtered = leaderboard(rows, { byType: 'saas-app' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].url).toBe('a')
  })

  it('drops NaN rollups', () => {
    const rows = [
      { url: 'a', runId: '1', rollupScore: NaN, dimensions: {}, ethicsViolations: 0 },
      { url: 'b', runId: '2', rollupScore: 7, dimensions: {}, ethicsViolations: 0 },
    ]
    expect(leaderboard(rows)).toHaveLength(1)
  })
})

describe('longitudinalFor', () => {
  it('returns one entry per snapshot of the URL, sorted by capturedAt', () => {
    const rows = [
      { url: 'https://x/', runId: '1', rollupScore: 4, capturedAt: '2020-01-01T00:00:00Z', dimensions: {}, ethicsViolations: 0 },
      { url: 'https://x/', runId: '2', rollupScore: 7, capturedAt: '2010-01-01T00:00:00Z', dimensions: {}, ethicsViolations: 0 },
      { url: 'https://y/', runId: '3', rollupScore: 9, capturedAt: '2024-01-01T00:00:00Z', dimensions: {}, ethicsViolations: 0 },
    ]
    const series = longitudinalFor(rows, 'https://x/')
    expect(series.map(s => s.capturedAt)).toEqual(['2010-01-01T00:00:00Z', '2020-01-01T00:00:00Z'])
  })
})

describe('compareRuns', () => {
  it('produces dimension deltas', () => {
    const a = { url: 'a', runId: '1', rollupScore: 8, dimensions: { product_intent: 8, visual_craft: 7 }, ethicsViolations: 0 }
    const b = { url: 'b', runId: '2', rollupScore: 6, dimensions: { product_intent: 6, visual_craft: 5 }, ethicsViolations: 0 }
    const cmp = compareRuns(a, b)
    expect(cmp.rollupDelta).toBe(2)
    expect(cmp.perDimension).toHaveLength(2)
    expect(cmp.perDimension.find(d => d.dim === 'product_intent')?.delta).toBe(2)
  })
})

describe('tierBuckets', () => {
  it('produces tier slices by rank', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      url: `${i}`, runId: `${i}`, rollupScore: 50 - i, dimensions: {}, ethicsViolations: 0,
    }))
    const buckets = tierBuckets(rows, [10, 25])
    expect(buckets[0].label).toBe('top 10')
    expect(buckets[0].rows).toHaveLength(10)
    expect(buckets[1].label).toBe('11–25')
    expect(buckets[2].label).toMatch(/^26\+/)
    expect(buckets[0].meanScore).toBeGreaterThan(buckets[1].meanScore)
  })
})
