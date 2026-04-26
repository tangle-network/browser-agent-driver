/**
 * Static report templates — markdown rendering of pre-aggregated data.
 *
 * No LLM. The narration layer (narrate.ts) wraps these with prose; the
 * templates themselves are pure functions of data so they're snapshot-testable
 * and deterministic.
 */

import type { Job } from '../jobs/types.js'
import type { AggregateRow, LongitudinalRow } from './types.js'
import { leaderboard, longitudinalFor, tierBuckets, compareRuns } from './aggregate.js'

export interface LeaderboardRenderOpts {
  title?: string
  topN?: number
  byType?: string
  /** Tier bucket boundaries — e.g. [10, 100, 200] → "top 10", "11–100", "101–200", "201+". */
  buckets?: number[]
}

export function renderLeaderboard(rows: AggregateRow[], opts: LeaderboardRenderOpts = {}): string {
  const lines: string[] = []
  const title = opts.title ?? 'Design Audit Leaderboard'
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  if (opts.byType) {
    lines.push(`Filtered to page-type: \`${opts.byType}\``)
    lines.push('')
  }

  const ranked = leaderboard(rows, { topN: opts.topN, byType: opts.byType })

  lines.push(`## Ranked sites (${ranked.length})`)
  lines.push('')
  lines.push('| # | URL | Page type | Rollup | Top dim | Bottom dim | Ethics |')
  lines.push('|---|-----|-----------|--------|---------|------------|--------|')
  ranked.forEach((r, i) => {
    const dims = Object.entries(r.dimensions)
    dims.sort((a, b) => (b[1] as number) - (a[1] as number))
    const top = dims[0] ? `${dims[0][0]} ${(dims[0][1] as number).toFixed(1)}` : '—'
    const bot = dims[dims.length - 1] ? `${dims[dims.length - 1][0]} ${(dims[dims.length - 1][1] as number).toFixed(1)}` : '—'
    lines.push(`| ${i + 1} | ${escapeMd(r.url)} | ${r.pageType ?? '?'} | ${r.rollupScore.toFixed(2)} | ${top} | ${bot} | ${r.ethicsViolations} |`)
  })
  lines.push('')

  if (opts.buckets && opts.buckets.length > 0) {
    const buckets = tierBuckets(rows, opts.buckets)
    lines.push('## Tiers')
    lines.push('')
    lines.push('| Tier | N | Mean | Median |')
    lines.push('|------|---|------|--------|')
    for (const b of buckets) {
      lines.push(`| ${b.label} | ${b.rows.length} | ${fmt(b.meanScore)} | ${fmt(b.medianScore)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export interface LongitudinalRenderOpts {
  title?: string
  /** If multiple URLs are in scope, render one section per URL. */
  urls?: string[]
}

export function renderLongitudinal(rows: AggregateRow[], opts: LongitudinalRenderOpts = {}): string {
  const lines: string[] = []
  lines.push(`# ${opts.title ?? 'Longitudinal Design Audit'}`)
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  const urls = opts.urls ?? Array.from(new Set(rows.map(r => r.url)))
  for (const url of urls) {
    const series = longitudinalFor(rows, url)
    if (series.length === 0) continue
    lines.push(`## ${escapeMd(url)}`)
    lines.push('')
    lines.push('| Captured | Rollup | Page type |')
    lines.push('|----------|--------|-----------|')
    for (const s of series) {
      lines.push(`| ${s.capturedAt.slice(0, 10)} | ${s.rollupScore.toFixed(2)} | ${s.pageType ?? '?'} |`)
    }
    const first = series[0]
    const last = series[series.length - 1]
    if (first && last && first !== last) {
      const delta = last.rollupScore - first.rollupScore
      const sign = delta >= 0 ? '+' : ''
      lines.push('')
      lines.push(`Net change ${first.capturedAt.slice(0, 10)} → ${last.capturedAt.slice(0, 10)}: **${sign}${delta.toFixed(2)}**`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export interface BatchComparisonRenderOpts {
  title?: string
  /** Pairs of (a, b) URLs to diff. If omitted, the first two URLs encountered are paired. */
  pairs?: Array<[string, string]>
}

export function renderBatchComparison(rows: AggregateRow[], opts: BatchComparisonRenderOpts = {}): string {
  const lines: string[] = []
  lines.push(`# ${opts.title ?? 'Batch Comparison'}`)
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  let pairs = opts.pairs ?? []
  if (pairs.length === 0) {
    const urls = Array.from(new Set(rows.map(r => r.url)))
    if (urls.length >= 2) pairs = [[urls[0], urls[1]]]
  }
  for (const [aUrl, bUrl] of pairs) {
    const a = rows.find(r => r.url === aUrl && Number.isFinite(r.rollupScore))
    const b = rows.find(r => r.url === bUrl && Number.isFinite(r.rollupScore))
    if (!a || !b) continue
    const cmp = compareRuns(a, b)
    lines.push(`## ${escapeMd(aUrl)} vs ${escapeMd(bUrl)}`)
    lines.push('')
    lines.push(`Rollup delta: **${signed(cmp.rollupDelta)}** (a ${a.rollupScore.toFixed(2)} – b ${b.rollupScore.toFixed(2)})`)
    lines.push('')
    if (cmp.perDimension.length > 0) {
      lines.push('| Dimension | a | b | Δ |')
      lines.push('|-----------|---|---|---|')
      for (const d of cmp.perDimension) {
        lines.push(`| ${d.dim} | ${d.afterScore.toFixed(1)} | ${d.beforeScore.toFixed(1)} | ${signed(d.delta)} |`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

export function renderJobHeader(job: Job): string {
  const ok = job.results.filter(r => r.status === 'ok').length
  const fail = job.results.filter(r => r.status === 'failed').length
  const skip = job.results.filter(r => r.status === 'skipped').length
  return [
    `**Job**: \`${job.jobId}\``,
    job.spec.label ? `**Label**: ${job.spec.label}` : undefined,
    `**Targets**: ${job.targets.length}  ·  ok: ${ok}  ·  failed: ${fail}  ·  skipped: ${skip}`,
    `**Cost**: $${job.totalCostUSD.toFixed(2)}`,
    `**Status**: ${job.status}`,
  ].filter(Boolean).join('  \n')
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function signed(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2)
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}
