import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReportTools } from '../src/reports/tools.js'
import { saveJob, appendIndexEntry } from '../src/jobs/store.js'
import type { Job } from '../src/jobs/types.js'

function execTool<I, O>(
  // The AI SDK's tool() wraps execute in a typed shim. Calling it via .execute
  // requires the SDK's tool-call options shape, which tests don't have. We
  // assert against the function reference and call it directly.
  tool: { execute?: (input: I, ctx?: unknown) => Promise<O> | O },
  input: I,
): Promise<O> {
  if (!tool.execute) throw new Error('tool has no execute')
  return Promise.resolve(tool.execute(input, { toolCallId: 'test', messages: [] }))
}

function setup(): { dir: string; jobId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bad-tools-'))
  // Two reports on disk, one ok / one to skip.
  const stripeRunDir = join(dir, 'run-stripe-2020')
  mkdirSync(stripeRunDir, { recursive: true })
  writeFileSync(join(stripeRunDir, 'report.json'), JSON.stringify({
    pages: [{
      auditResultV2: { classification: { type: 'marketing', domain: 'fintech' }, rollup: { score: 8.5 }, scores: { product_intent: { score: 9 } } },
      ethicsViolations: [],
    }],
  }))
  const linearRunDir = join(dir, 'run-linear-2024')
  mkdirSync(linearRunDir, { recursive: true })
  writeFileSync(join(linearRunDir, 'report.json'), JSON.stringify({
    pages: [{
      auditResultV2: { classification: { type: 'saas-app' }, rollup: { score: 9.2 }, scores: { product_intent: { score: 9 } } },
      ethicsViolations: [],
    }],
  }))
  const job: Job = {
    jobId: 'job_test_001',
    spec: { kind: 'comparative-audit', discover: { source: 'wayback', urls: ['https://stripe.com', 'https://linear.app'] } },
    status: 'completed',
    createdAt: new Date().toISOString(),
    targets: [
      { url: 'https://stripe.com', snapshotUrl: 'https://stripe.com/2020', capturedAt: '2020-01-01T00:00:00Z' },
      { url: 'https://linear.app', snapshotUrl: 'https://linear.app/2024', capturedAt: '2024-01-01T00:00:00Z' },
    ],
    results: [
      {
        url: 'https://stripe.com', snapshotUrl: 'https://stripe.com/2020', capturedAt: '2020-01-01T00:00:00Z',
        status: 'ok', runId: 'run-stripe-2020', resultPath: join(stripeRunDir, 'report.json'),
        rollupScore: 8.5, pageType: 'marketing',
      },
      {
        url: 'https://linear.app', snapshotUrl: 'https://linear.app/2024', capturedAt: '2024-01-01T00:00:00Z',
        status: 'ok', runId: 'run-linear-2024', resultPath: join(linearRunDir, 'report.json'),
        rollupScore: 9.2, pageType: 'saas-app',
      },
    ],
    totalCostUSD: 0.8,
  }
  saveJob(job, dir)
  appendIndexEntry(job, dir)
  return { dir, jobId: job.jobId }
}

describe('buildReportTools', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('exposes the documented tool surface', () => {
    const tools = buildReportTools()
    const names = Object.keys(tools).sort()
    expect(names).toEqual(['compareRuns', 'diffTokens', 'fetchAudit', 'fetchTokens', 'longitudinal', 'queryJob', 'renderTemplate', 'runFreshAudit', 'tierBuckets'].sort())
  })

  it('queryJob returns ranked rows', async () => {
    const ctx = setup(); dir = ctx.dir
    const tools = buildReportTools({ jobsDir: ctx.dir })
    const rows = await execTool(tools.queryJob, { jobId: ctx.jobId })
    expect(Array.isArray(rows)).toBe(true)
    expect((rows as Array<{ rollupScore: number }>)[0].rollupScore).toBeGreaterThan(8)
  })

  it('compareRuns produces a deterministic delta', async () => {
    const ctx = setup(); dir = ctx.dir
    const tools = buildReportTools({ jobsDir: ctx.dir })
    const cmp = await execTool(tools.compareRuns, { jobId: ctx.jobId, runIdA: 'run-stripe-2020', runIdB: 'run-linear-2024' })
    expect((cmp as { rollupDelta: number }).rollupDelta).toBeCloseTo(8.5 - 9.2, 1)
  })

  it('renderTemplate emits markdown', async () => {
    const ctx = setup(); dir = ctx.dir
    const tools = buildReportTools({ jobsDir: ctx.dir })
    const out = await execTool(tools.renderTemplate, { jobId: ctx.jobId, template: 'leaderboard' })
    expect((out as { markdown: string }).markdown).toMatch(/# Design Audit Leaderboard/)
  })

  it('runFreshAudit refuses without a wired resolver', async () => {
    const tools = buildReportTools()
    await expect(execTool(tools.runFreshAudit, { url: 'https://x' })).rejects.toThrow(/runFreshAudit not wired/)
  })

  it('runFreshAudit dispatches to the injected resolver', async () => {
    const tools = buildReportTools({
      runFreshAudit: async (url) => ({ runId: 'fresh', resultPath: '/tmp/x', rollupScore: 7 }),
    })
    const out = await execTool(tools.runFreshAudit, { url: 'https://x' })
    expect((out as { runId: string }).runId).toBe('fresh')
  })

  it('fetchAudit throws when runId is unknown', async () => {
    const ctx = setup(); dir = ctx.dir
    const tools = buildReportTools({ jobsDir: ctx.dir })
    await expect(execTool(tools.fetchAudit, { jobId: ctx.jobId, runId: 'nope' })).rejects.toThrow(/runId not found/)
  })
})
