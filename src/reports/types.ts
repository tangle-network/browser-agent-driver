/**
 * Report shapes — flat rows that templates and tool calls share.
 *
 * `AggregateRow` is intentionally narrow (just the fields a leaderboard /
 * comparison / longitudinal view needs). Anything richer should be loaded
 * from `resultPath` on demand via `fetchAudit`.
 */

import type { Dimension } from '../design/audit/v2/types.js'

export interface AggregateRow {
  /** Seed URL (groups multiple snapshots of the same site together). */
  url: string
  /** Snapshot URL (only set for wayback rows). */
  snapshotUrl?: string
  /** ISO datetime of capture (only set for wayback rows). */
  capturedAt?: string
  /** runId of the source audit. */
  runId: string
  /** Page-type classification from the audit. */
  pageType?: string
  /** Domain tag (e.g. "fintech", "health") from classification. */
  domain?: string
  /** Rollup score (0-10). */
  rollupScore: number
  /** Per-dimension scores (subset — only the v2 universal dimensions). */
  dimensions: Partial<Record<Dimension, number>>
  /** Number of ethics violations detected. */
  ethicsViolations: number
  /** Path to the per-run report.json for drill-down. */
  resultPath?: string
}

export interface DimensionDelta {
  dim: Dimension
  beforeScore: number
  afterScore: number
  delta: number
}

export interface CompareRunsResult {
  a: AggregateRow
  b: AggregateRow
  rollupDelta: number
  /** Negative = a worse than b, positive = a better. */
  perDimension: DimensionDelta[]
}

export interface LongitudinalRow {
  url: string
  capturedAt: string
  rollupScore: number
  pageType?: string
}

export type ReportTemplate = 'leaderboard' | 'longitudinal' | 'batch-comparison'
