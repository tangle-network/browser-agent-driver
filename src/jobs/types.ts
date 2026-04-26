/**
 * Job orchestration types — RFC-003: comparative-audit jobs.
 *
 * A job is a declarative spec ("audit these N URLs, optionally with M historical
 * snapshots each") that fans out to the existing design-audit pipeline and
 * persists the aggregate result so report generation can run later.
 *
 * Persistence: append-only JSONL at `~/.bad/jobs/<jobId>.json` (whole-file
 * rewrites are fine — jobs are small) plus a one-line index entry at
 * `~/.bad/jobs/index.jsonl` for fast listing.
 */

import type { AudienceTag, ModalityTag, RegulatoryContextTag, AudienceVulnerabilityTag } from '../design/audit/v2/types.js'

export type JobKind = 'comparative-audit'

export type JobStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled'

export type DiscoverSource = 'list' | 'wayback'

/** What targets to audit. `list` = explicit URLs; `wayback` = expand each URL into historical snapshots. */
export interface DiscoverSpec {
  source: DiscoverSource
  /** Explicit list of URLs (always required — it's the seed even for wayback). */
  urls: string[]
  /** wayback only: how many evenly-spaced snapshots to fetch per URL. Default 5. */
  snapshotsPerUrl?: number
  /** wayback only: ISO date lower bound (e.g. "2010-01-01"). */
  since?: string
  /** wayback only: ISO date upper bound (e.g. "2026-01-01"). */
  until?: string
}

/** Pass-through audit options — mirrors the design-audit CLI flags. */
export interface AuditOptions {
  pages?: number
  modality?: 'html' | 'ios' | 'android'
  audience?: AudienceTag[]
  audienceVulnerability?: AudienceVulnerabilityTag[]
  modalityTag?: ModalityTag[]
  regulatoryContext?: RegulatoryContextTag[]
  headless?: boolean
  skipEthics?: boolean
  /**
   * Layer 8 add-on: also run the deterministic brand/design-token extractor at
   * every target. Adds ~10s/target (no LLM). Output lands at
   * `<resultPath dir>/tokens.json` and is surfaced via `JobResultEntry.tokensPath`.
   */
  extractTokens?: boolean
}

export interface JobSpec {
  kind: JobKind
  discover: DiscoverSpec
  audit?: AuditOptions
  /** Bounded concurrency for the audit fan-out. Default 2 — Playwright + LLM rate limits cap real-world throughput. */
  concurrency?: number
  /** Hard cost cap. The job aborts pre-flight if estimated cost exceeds this. */
  maxCostUSD?: number
  /** Free-form label for humans (shows up in `bad jobs list`). */
  label?: string
}

/** One target = one (url, optional snapshot) pair the auditor will run on. */
export interface JobTarget {
  /** The original seed URL. For non-wayback discovery, this is also the audit URL. */
  url: string
  /** For wayback targets: the actual snapshot URL passed to the audit. */
  snapshotUrl?: string
  /** For wayback targets: ISO datetime when the snapshot was captured. */
  capturedAt?: string
}

export type JobResultStatus = 'ok' | 'failed' | 'skipped'

export interface JobResultEntry extends JobTarget {
  status: JobResultStatus
  /** runId of the design-audit run when status === 'ok'. */
  runId?: string
  /** Path to the run's report.json (relative to cwd or absolute). */
  resultPath?: string
  /** Failure reason when status === 'failed' or 'skipped'. */
  error?: string
  /** Estimated USD cost of this audit (if available from telemetry). */
  costUSD?: number
  /** Roll-up score copied out of the report for fast aggregation queries. */
  rollupScore?: number
  /** Page-type classification. */
  pageType?: string
  /** Path to the tokens.json from the brand-kit extractor (when extractTokens=true). */
  tokensPath?: string
}

export interface Job {
  jobId: string
  spec: JobSpec
  status: JobStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  /** All discovered targets (length = number of audits the job will / did run). */
  targets: JobTarget[]
  /** Per-target outcome. Length matches `targets` once the job has progressed past discovery. */
  results: JobResultEntry[]
  /** Sum of `results[*].costUSD` for completed entries. */
  totalCostUSD: number
  /** Free-form notes (errors, warnings, telemetry summary). */
  notes?: string[]
}

export interface CostEstimate {
  targetCount: number
  estimatedTotalUSD: number
  perAuditUSD: number
  /** Whether the estimate is above `spec.maxCostUSD`. */
  exceedsCap: boolean
}
