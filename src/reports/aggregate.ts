/**
 * Deterministic aggregation over a job's per-target audit results.
 *
 * Every number that shows up in a report flows through here — never through
 * an LLM. The narration layer can describe / contextualize / dramatize, but
 * counts, scores, deltas, and rankings are all computed here. Same pattern
 * we use for the audit patches contract: agent narrates, code computes.
 */

import * as fs from 'node:fs'
import type { Job, JobResultEntry } from '../jobs/types.js'
import type { Dimension } from '../design/audit/score-types.js'
import type { AggregateRow, CompareRunsResult, DimensionDelta, LongitudinalRow } from './types.js'

interface RawReport {
  pages?: Array<{
    url?: string
    classification?: { type?: string; domain?: string }
    auditResult?: {
      classification?: { type?: string; domain?: string }
      rollup?: { score?: number }
      scores?: Partial<Record<Dimension, { score?: number }>>
    }
    rollup?: { score?: number }
    designSystemScore?: Partial<Record<string, number>>
    ethicsViolations?: unknown[]
    score?: number
  }>
}

/**
 * Read each ok result's `report.json` from disk and project to AggregateRow.
 * Skipped/failed entries become rows with `rollupScore: NaN` so callers can
 * filter them — keeping them in the list preserves index alignment with
 * `job.results` for tools that want to drill in.
 */
export function aggregateJob(job: Job): AggregateRow[] {
  const out: AggregateRow[] = []
  for (const r of job.results) {
    out.push(toRow(r))
  }
  return out
}

function toRow(r: JobResultEntry): AggregateRow {
  const base: AggregateRow = {
    url: r.url,
    snapshotUrl: r.snapshotUrl,
    capturedAt: r.capturedAt,
    runId: r.runId ?? '',
    rollupScore: typeof r.rollupScore === 'number' ? r.rollupScore : NaN,
    dimensions: {},
    ethicsViolations: 0,
    resultPath: r.resultPath,
    pageType: r.pageType,
  }
  if (r.status !== 'ok' || !r.resultPath || !fs.existsSync(r.resultPath)) {
    return base
  }
  try {
    const json = JSON.parse(fs.readFileSync(r.resultPath, 'utf-8')) as RawReport
    const page = json.pages?.[0]
    if (!page) return base
    const result = page.auditResult
    const cls = result?.classification ?? page.classification ?? {}
    base.pageType = base.pageType ?? cls.type
    base.domain = cls.domain
    if (result?.rollup?.score !== undefined) base.rollupScore = result.rollup.score
    else if (page.rollup?.score !== undefined) base.rollupScore = page.rollup.score
    else if (typeof page.score === 'number') base.rollupScore = page.score
    if (result?.scores) {
      for (const [dim, ds] of Object.entries(result.scores) as [Dimension, { score?: number } | undefined][]) {
        if (ds && typeof ds.score === 'number') base.dimensions[dim] = ds.score
      }
    }
    base.ethicsViolations = Array.isArray(page.ethicsViolations) ? page.ethicsViolations.length : 0
  } catch {
    // Corrupt or partial report.json — leave as-is. Don't pretend we have data we don't.
  }
  return base
}

export interface LeaderboardOptions {
  /** Filter by page type (e.g. only saas-app rows). */
  byType?: string
  /** Top N entries. Default = no cap. */
  topN?: number
  /** Sort direction. Default 'desc' (highest first). */
  direction?: 'asc' | 'desc'
}

export function leaderboard(rows: AggregateRow[], opts: LeaderboardOptions = {}): AggregateRow[] {
  const dir = opts.direction ?? 'desc'
  const filtered = rows
    .filter(r => Number.isFinite(r.rollupScore))
    .filter(r => !opts.byType || r.pageType === opts.byType)
  filtered.sort((a, b) => (dir === 'desc' ? b.rollupScore - a.rollupScore : a.rollupScore - b.rollupScore))
  if (opts.topN && opts.topN > 0) return filtered.slice(0, opts.topN)
  return filtered
}

/** Longitudinal view: all snapshots for one URL, sorted by capture time. */
export function longitudinalFor(rows: AggregateRow[], url: string): LongitudinalRow[] {
  return rows
    .filter(r => r.url === url && r.capturedAt && Number.isFinite(r.rollupScore))
    .map<LongitudinalRow>(r => ({
      url: r.url,
      capturedAt: r.capturedAt!,
      rollupScore: r.rollupScore,
      pageType: r.pageType,
    }))
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}

export function compareRuns(a: AggregateRow, b: AggregateRow): CompareRunsResult {
  const dims = new Set<Dimension>([
    ...(Object.keys(a.dimensions) as Dimension[]),
    ...(Object.keys(b.dimensions) as Dimension[]),
  ])
  const perDimension: DimensionDelta[] = []
  for (const dim of dims) {
    const ax = a.dimensions[dim]
    const bx = b.dimensions[dim]
    if (typeof ax !== 'number' || typeof bx !== 'number') continue
    perDimension.push({ dim, beforeScore: bx, afterScore: ax, delta: round2(ax - bx) })
  }
  return {
    a,
    b,
    rollupDelta: round2(a.rollupScore - b.rollupScore),
    perDimension,
  }
}

/** Group rows into tier buckets for "top 10 vs 100-200" style reports. */
export interface TierBucket {
  label: string
  rows: AggregateRow[]
  meanScore: number
  medianScore: number
}

export function tierBuckets(rows: AggregateRow[], boundaries: number[]): TierBucket[] {
  const ranked = leaderboard(rows)
  const buckets: TierBucket[] = []
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b)
  let prev = 0
  for (const upper of sorted) {
    const slice = ranked.slice(prev, upper)
    if (slice.length === 0) {
      prev = upper
      continue
    }
    const label = prev === 0 ? `top ${upper}` : `${prev + 1}–${upper}`
    buckets.push({ label, rows: slice, ...stats(slice) })
    prev = upper
  }
  if (prev < ranked.length) {
    const slice = ranked.slice(prev)
    buckets.push({ label: `${prev + 1}+`, rows: slice, ...stats(slice) })
  }
  return buckets
}

function stats(rows: AggregateRow[]): { meanScore: number; medianScore: number } {
  if (rows.length === 0) return { meanScore: NaN, medianScore: NaN }
  const scores = rows.map(r => r.rollupScore).filter(Number.isFinite)
  const sum = scores.reduce((a, b) => a + b, 0)
  const sorted = [...scores].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return {
    meanScore: round2(sum / scores.length),
    medianScore: round2(median),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
