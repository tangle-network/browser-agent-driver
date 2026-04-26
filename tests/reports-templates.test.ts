import { describe, it, expect } from 'vitest'
import { renderLeaderboard, renderLongitudinal, renderBatchComparison, renderJobHeader } from '../src/reports/templates.js'
import type { AggregateRow } from '../src/reports/types.js'
import type { Job } from '../src/jobs/types.js'

const ROWS: AggregateRow[] = [
  { url: 'https://stripe.com', runId: 'r1', rollupScore: 8.7, dimensions: { product_intent: 9, visual_craft: 8 }, ethicsViolations: 0, pageType: 'marketing' },
  { url: 'https://linear.app', runId: 'r2', rollupScore: 9.1, dimensions: { product_intent: 9, visual_craft: 9 }, ethicsViolations: 0, pageType: 'saas-app' },
  { url: 'https://dropbox.com', runId: 'r3', rollupScore: 6.5, dimensions: { product_intent: 7, visual_craft: 6 }, ethicsViolations: 1, pageType: 'marketing' },
]

describe('renderLeaderboard', () => {
  it('produces a markdown table with rows in descending order', () => {
    const md = renderLeaderboard(ROWS)
    expect(md).toMatch(/# Design Audit Leaderboard/)
    expect(md).toMatch(/\| 1 \| https:\/\/linear\.app/)
    expect(md).toMatch(/\| 2 \| https:\/\/stripe\.com/)
    expect(md).toMatch(/\| 3 \| https:\/\/dropbox\.com/)
  })

  it('honors byType filter', () => {
    const md = renderLeaderboard(ROWS, { byType: 'marketing' })
    expect(md).toMatch(/page-type: `marketing`/)
    expect(md).toMatch(/stripe\.com/)
    expect(md).not.toMatch(/linear\.app/)
  })

  it('emits tier buckets when boundaries are supplied', () => {
    const md = renderLeaderboard(ROWS, { buckets: [1, 2] })
    expect(md).toMatch(/## Tiers/)
    expect(md).toMatch(/top 1/)
    expect(md).toMatch(/2–2/)
  })

  it('escapes pipe characters in URLs to keep table integrity', () => {
    const rows: AggregateRow[] = [{ url: 'https://x.com/path|with|pipes', runId: 'r1', rollupScore: 5, dimensions: {}, ethicsViolations: 0 }]
    const md = renderLeaderboard(rows)
    expect(md).toMatch(/path\\\|with\\\|pipes/)
  })
})

describe('renderLongitudinal', () => {
  it('produces one section per URL with sorted captures', () => {
    const rows: AggregateRow[] = [
      { url: 'https://stripe.com', runId: 'r1', rollupScore: 5, capturedAt: '2010-01-01T00:00:00Z', dimensions: {}, ethicsViolations: 0 },
      { url: 'https://stripe.com', runId: 'r2', rollupScore: 8, capturedAt: '2020-01-01T00:00:00Z', dimensions: {}, ethicsViolations: 0 },
    ]
    const md = renderLongitudinal(rows)
    expect(md).toMatch(/## https:\/\/stripe\.com/)
    expect(md).toMatch(/Net change 2010-01-01 → 2020-01-01: \*\*\+3\.00\*\*/)
  })
})

describe('renderBatchComparison', () => {
  it('diffs the first two rows when no pairs given', () => {
    const md = renderBatchComparison(ROWS)
    expect(md).toMatch(/## https:\/\/stripe\.com vs https:\/\/linear\.app/)
    expect(md).toMatch(/Rollup delta: \*\*-0\.40\*\*/)
  })
})

describe('renderJobHeader', () => {
  it('summarizes ok / failed / skipped counts and cost', () => {
    const job: Job = {
      jobId: 'job_abc',
      spec: { kind: 'comparative-audit', discover: { source: 'list', urls: [] }, label: 'YC W25' },
      status: 'completed',
      createdAt: new Date().toISOString(),
      targets: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
      results: [
        { url: 'a', status: 'ok' },
        { url: 'b', status: 'ok' },
        { url: 'c', status: 'failed', error: 'x' },
      ],
      totalCostUSD: 1.23,
    }
    const md = renderJobHeader(job)
    expect(md).toMatch(/job_abc/)
    expect(md).toMatch(/YC W25/)
    expect(md).toMatch(/ok: 2/)
    expect(md).toMatch(/failed: 1/)
    expect(md).toMatch(/\$1\.23/)
  })
})
