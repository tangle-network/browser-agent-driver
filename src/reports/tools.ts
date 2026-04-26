/**
 * AI SDK tool surface for the report agent.
 *
 * These tools let an LLM agent (browser-side chat, Claude Code, anywhere
 * AI SDK runs) interrogate a job's audit results. The contract is strict:
 * every numerical claim the agent makes must come from a tool result, never
 * from its own arithmetic. Templates are deterministic; the agent narrates.
 *
 * The tools use plain JSONSchema (`jsonSchema` from `ai`) rather than zod so
 * we don't add a dependency. Schemas are intentionally minimal — agents prefer
 * concise tool surfaces.
 */

import { tool, jsonSchema } from 'ai'
import * as fs from 'node:fs'
import { loadJob } from '../jobs/store.js'
import { aggregateJob, leaderboard, longitudinalFor, compareRuns, tierBuckets } from './aggregate.js'
import { aggregateTokens, diffTokens as diffTokensFn, groupByUrl } from './tokens.js'
import { renderLeaderboard, renderLongitudinal, renderBatchComparison, renderBrandEvolution } from './templates.js'
import type { AggregateRow } from './types.js'

export interface ReportToolsContext {
  /** Override jobs dir (tests). */
  jobsDir?: string
  /** Override the resolver for `runFreshAudit` so tests/CLIs can plug in their own pipeline. */
  runFreshAudit?: (url: string) => Promise<{ runId: string; resultPath: string; rollupScore?: number }>
}

function rowsForJob(jobId: string, jobsDir?: string): AggregateRow[] {
  const job = loadJob(jobId, jobsDir)
  if (!job) throw new Error(`job not found: ${jobId}`)
  return aggregateJob(job)
}

export function buildReportTools(ctx: ReportToolsContext = {}) {
  return {
    queryJob: tool({
      description: 'Return aggregated rows for every audited target in a job (filtered/ranked). Use this for any leaderboard, ranking, or scope query.',
      inputSchema: jsonSchema<{ jobId: string; byType?: string; topN?: number; direction?: 'asc' | 'desc' }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          byType: { type: 'string', description: 'Filter to one page-type (saas-app, marketing, dashboard, ecommerce, ...).' },
          topN: { type: 'integer', minimum: 1 },
          direction: { type: 'string', enum: ['asc', 'desc'], description: 'Default desc (highest scores first).' },
        },
        required: ['jobId'],
      }),
      execute: async ({ jobId, byType, topN, direction }) => {
        const rows = rowsForJob(jobId, ctx.jobsDir)
        return leaderboard(rows, { byType, topN, direction })
      },
    }),

    fetchAudit: tool({
      description: 'Fetch the full report.json for a single audit run by runId. Use sparingly — only when the agent needs finding-level detail beyond aggregated scores.',
      inputSchema: jsonSchema<{ jobId: string; runId: string }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          runId: { type: 'string' },
        },
        required: ['jobId', 'runId'],
      }),
      execute: async ({ jobId, runId }) => {
        const job = loadJob(jobId, ctx.jobsDir)
        if (!job) throw new Error(`job not found: ${jobId}`)
        const entry = job.results.find(r => r.runId === runId)
        if (!entry || !entry.resultPath || !fs.existsSync(entry.resultPath)) {
          throw new Error(`runId not found or report.json missing: ${runId}`)
        }
        return JSON.parse(fs.readFileSync(entry.resultPath, 'utf-8'))
      },
    }),

    compareRuns: tool({
      description: 'Compute a deterministic dimension-by-dimension diff between two audited runs in the same job. Returns rollupDelta and per-dimension deltas.',
      inputSchema: jsonSchema<{ jobId: string; runIdA: string; runIdB: string }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          runIdA: { type: 'string' },
          runIdB: { type: 'string' },
        },
        required: ['jobId', 'runIdA', 'runIdB'],
      }),
      execute: async ({ jobId, runIdA, runIdB }) => {
        const rows = rowsForJob(jobId, ctx.jobsDir)
        const a = rows.find(r => r.runId === runIdA)
        const b = rows.find(r => r.runId === runIdB)
        if (!a || !b) throw new Error(`runId not found in job: ${!a ? runIdA : runIdB}`)
        return compareRuns(a, b)
      },
    }),

    longitudinal: tool({
      description: 'For wayback-expanded jobs, return the time series of scores for one URL (sorted oldest → newest). Use this for "how has X evolved" questions.',
      inputSchema: jsonSchema<{ jobId: string; url: string }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['jobId', 'url'],
      }),
      execute: async ({ jobId, url }) => {
        const rows = rowsForJob(jobId, ctx.jobsDir)
        return longitudinalFor(rows, url)
      },
    }),

    tierBuckets: tool({
      description: 'Bucket a job\'s ranked results into tier slices (e.g. boundaries [10, 100, 200] → top 10 / 11–100 / 101–200 / 201+).',
      inputSchema: jsonSchema<{ jobId: string; boundaries: number[] }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          boundaries: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
        required: ['jobId', 'boundaries'],
      }),
      execute: async ({ jobId, boundaries }) => {
        const rows = rowsForJob(jobId, ctx.jobsDir)
        return tierBuckets(rows, boundaries)
      },
    }),

    renderTemplate: tool({
      description: 'Render a deterministic markdown report from a job. Use this when the user wants a shareable artifact, not a free-form answer.',
      inputSchema: jsonSchema<{
        jobId: string
        template: 'leaderboard' | 'longitudinal' | 'batch-comparison' | 'brand-evolution'
        title?: string
        topN?: number
        byType?: string
        buckets?: number[]
      }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          template: { type: 'string', enum: ['leaderboard', 'longitudinal', 'batch-comparison', 'brand-evolution'] },
          title: { type: 'string' },
          topN: { type: 'integer', minimum: 1 },
          byType: { type: 'string' },
          buckets: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
        required: ['jobId', 'template'],
      }),
      execute: async ({ jobId, template, title, topN, byType, buckets }) => {
        if (template === 'brand-evolution') {
          const job = loadJob(jobId, ctx.jobsDir)
          if (!job) throw new Error(`job not found: ${jobId}`)
          return { markdown: renderBrandEvolution(job, { title }) }
        }
        const rows = rowsForJob(jobId, ctx.jobsDir)
        if (template === 'leaderboard') return { markdown: renderLeaderboard(rows, { title, topN, byType, buckets }) }
        if (template === 'longitudinal') return { markdown: renderLongitudinal(rows, { title }) }
        return { markdown: renderBatchComparison(rows, { title }) }
      },
    }),

    fetchTokens: tool({
      description: 'Return aggregated brand-kit token summaries (colors, fonts, libraries, brand metadata) for every audited target that had token extraction enabled. Use for "what colors does X use" or "how has the design system evolved" questions.',
      inputSchema: jsonSchema<{ jobId: string; url?: string }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          url: { type: 'string', description: 'Filter to one URL (returns the chronological series).' },
        },
        required: ['jobId'],
      }),
      execute: async ({ jobId, url }) => {
        const job = loadJob(jobId, ctx.jobsDir)
        if (!job) throw new Error(`job not found: ${jobId}`)
        const summaries = aggregateTokens(job)
        if (url) {
          const series = groupByUrl(summaries).find(s => s.url === url)
          return series ? series.snapshots : []
        }
        return summaries
      },
    }),

    diffTokens: tool({
      description: 'Compute the token delta (colors added/removed, font families added/removed, brand-meta changes, library swaps) between two audited targets in the same job.',
      inputSchema: jsonSchema<{ jobId: string; runIdA: string; runIdB: string }>({
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          runIdA: { type: 'string' },
          runIdB: { type: 'string' },
        },
        required: ['jobId', 'runIdA', 'runIdB'],
      }),
      execute: async ({ jobId, runIdA, runIdB }) => {
        const job = loadJob(jobId, ctx.jobsDir)
        if (!job) throw new Error(`job not found: ${jobId}`)
        const summaries = aggregateTokens(job)
        const a = summaries.find(s => s.runId === runIdA)
        const b = summaries.find(s => s.runId === runIdB)
        if (!a || !b) throw new Error(`token summary not found for ${!a ? runIdA : runIdB} — was extractTokens enabled?`)
        return diffTokensFn(a, b)
      },
    }),

    runFreshAudit: tool({
      description: 'Kick off a NEW single-page audit when the agent needs current data not in the job. Cost-bearing. Use sparingly.',
      inputSchema: jsonSchema<{ url: string }>({
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      }),
      execute: async ({ url }) => {
        if (!ctx.runFreshAudit) {
          throw new Error('runFreshAudit not wired in this context — host must inject a resolver')
        }
        return await ctx.runFreshAudit(url)
      },
    }),
  } as const
}

export type ReportToolSet = ReturnType<typeof buildReportTools>
