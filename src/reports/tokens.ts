/**
 * Brand-kit / design-token aggregation across a job's targets.
 *
 * Reads each per-target `tokens.json` (produced when AuditOptions.extractTokens
 * was true) and projects to a flat row shape so longitudinal evolution and
 * batch comparison templates can render without re-implementing extraction.
 *
 * No LLM. Pure function of on-disk data — same contract as aggregate.ts.
 *
 * Schema-version contract: `tokens.json` files older than `MIN_TOKENS_SCHEMA`
 * are skipped with a warning. The aggregator never silently coerces old
 * shapes — better empty rows than wrong rows.
 */

import * as fs from 'node:fs'
import type { Job } from '../jobs/types.js'
import type { DesignTokens, ColorToken, FontFamily } from '../types.js'

/** Minimum acceptable schemaVersion for tokens.json. Bump when the shape changes incompatibly. */
export const MIN_TOKENS_SCHEMA = 1
/** Most recent schemaVersion we know how to read. Future versions will warn but still attempt to parse. */
export const CURRENT_TOKENS_SCHEMA = 1

export interface TokenSummary {
  /** Seed URL (groups snapshots of the same site). */
  url: string
  /** Snapshot URL when wayback. */
  snapshotUrl?: string
  /** ISO datetime of capture. */
  capturedAt?: string
  /** Per-target runId (== outputDir for jobs). */
  runId: string
  /** Resolved on-disk path to tokens.json. */
  tokensPath?: string
  /** Top-level brand metadata (title, theme color, favicon, og image). */
  brand: DesignTokens['brand']
  /** All distinct colors, sorted desc by usage count. */
  colors: ColorToken[]
  /** Distinct typography families with classification + weight set. */
  fontFamilies: FontFamily[]
  /** Type-scale entry count (proxy for typographic complexity). */
  typeScaleEntries: number
  /** Logo asset URLs (svg + raster). */
  logos: string[]
  /** Loaded font-file URLs. */
  fontFiles: string[]
  /** Detected libraries (e.g. ['tailwind','radix-ui']). */
  detectedLibraries: string[]
}

/** Read each ok result's tokens.json and project to TokenSummary. */
export function aggregateTokens(job: Job): TokenSummary[] {
  const out: TokenSummary[] = []
  for (const r of job.results) {
    if (r.status !== 'ok' || !r.tokensPath || !fs.existsSync(r.tokensPath)) continue
    try {
      const raw = JSON.parse(fs.readFileSync(r.tokensPath, 'utf-8')) as DesignTokens & { schemaVersion?: number }
      // Only enforce when schemaVersion is present. Pre-versioned files (the
      // bulk of existing jobs at the time this check landed) are accepted as
      // implicitly v1 — see CURRENT_TOKENS_SCHEMA.
      if (typeof raw.schemaVersion === 'number' && raw.schemaVersion < MIN_TOKENS_SCHEMA) continue
      const tokens = raw
      out.push({
        url: r.url,
        snapshotUrl: r.snapshotUrl,
        capturedAt: r.capturedAt,
        runId: r.runId ?? '',
        tokensPath: r.tokensPath,
        brand: tokens.brand ?? {},
        colors: (tokens.colors ?? []).slice().sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
        fontFamilies: tokens.typography?.families ?? [],
        typeScaleEntries: tokens.typography?.scale?.length ?? 0,
        logos: (tokens.logos ?? []).map(l => l.src ?? '').filter(Boolean),
        fontFiles: (tokens.fontFiles ?? []).map(f => f.src).filter(Boolean),
        detectedLibraries: tokens.detectedLibraries ?? [],
      })
    } catch {
      // Skip corrupted token files.
    }
  }
  return out
}

/**
 * Diff between two TokenSummary records. Useful for "this URL evolved from
 * 4 colors → 12 colors and dropped Helvetica for Inter" callouts.
 */
export interface TokenDiff {
  colorsAdded: string[]
  colorsRemoved: string[]
  colorsCommon: number
  familiesAdded: string[]
  familiesRemoved: string[]
  brandChanges: Array<{ field: keyof DesignTokens['brand']; before: string | undefined; after: string | undefined }>
  librariesAdded: string[]
  librariesRemoved: string[]
}

export function diffTokens(a: TokenSummary, b: TokenSummary): TokenDiff {
  const aHex = new Set(a.colors.map(c => c.hex.toLowerCase()))
  const bHex = new Set(b.colors.map(c => c.hex.toLowerCase()))
  const colorsAdded = [...bHex].filter(h => !aHex.has(h))
  const colorsRemoved = [...aHex].filter(h => !bHex.has(h))
  const colorsCommon = [...aHex].filter(h => bHex.has(h)).length

  const aFam = new Set(a.fontFamilies.map(f => f.family))
  const bFam = new Set(b.fontFamilies.map(f => f.family))
  const familiesAdded = [...bFam].filter(f => !aFam.has(f))
  const familiesRemoved = [...aFam].filter(f => !bFam.has(f))

  const brandFields: Array<keyof DesignTokens['brand']> = ['title', 'description', 'themeColor', 'favicon', 'ogImage']
  const brandChanges = brandFields
    .filter(f => (a.brand?.[f] ?? '') !== (b.brand?.[f] ?? ''))
    .map(f => ({ field: f, before: a.brand?.[f], after: b.brand?.[f] }))

  const aLib = new Set(a.detectedLibraries)
  const bLib = new Set(b.detectedLibraries)
  const librariesAdded = [...bLib].filter(l => !aLib.has(l))
  const librariesRemoved = [...aLib].filter(l => !bLib.has(l))

  return { colorsAdded, colorsRemoved, colorsCommon, familiesAdded, familiesRemoved, brandChanges, librariesAdded, librariesRemoved }
}

/**
 * Group token summaries by URL and return a chronological evolution series.
 * Returns one entry per URL; each carries the sequence of TokenSummary rows
 * sorted by capturedAt (or insertion order when capturedAt is missing).
 */
export interface TokenSeries {
  url: string
  snapshots: TokenSummary[]
}

export function groupByUrl(summaries: TokenSummary[]): TokenSeries[] {
  const map = new Map<string, TokenSummary[]>()
  for (const s of summaries) {
    if (!map.has(s.url)) map.set(s.url, [])
    map.get(s.url)!.push(s)
  }
  const out: TokenSeries[] = []
  for (const [url, snapshots] of map.entries()) {
    snapshots.sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''))
    out.push({ url, snapshots })
  }
  return out
}
