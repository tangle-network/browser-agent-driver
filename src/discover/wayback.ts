/**
 * Wayback Machine snapshot discoverer (CDX API).
 *
 * Uses archive.org's CDX server to list captures of a URL, then samples
 * `count` snapshots evenly across the time range. The CDX API is rate-limited
 * (~15 req/s) but for the small N we use here we never approach the cap.
 *
 * CDX response shape:
 *   [["urlkey","timestamp","original","mimetype","statuscode","digest","length"],
 *    ["com,stripe)/", "20100101120000", "https://stripe.com/", "text/html", "200", "...", "1234"],
 *    ...]
 *
 * Snapshot URL = `https://web.archive.org/web/<timestamp>/<original>`.
 */

import type { JobTarget } from '../jobs/types.js'

const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx'

export interface WaybackOptions {
  /** Snapshots per URL. Default 5. */
  count?: number
  /** Lower-bound capture date (ISO 8601 — e.g. "2010-01-01"). */
  since?: string
  /** Upper-bound capture date. */
  until?: string
  /** Limit only HTTP 200 captures. Default true — 4xx/5xx snapshots aren't auditable. */
  status200Only?: boolean
  /** Injected fetch (tests). Defaults to globalThis.fetch (Node 18+). */
  fetch?: typeof fetch
}

interface CdxRow {
  urlkey: string
  timestamp: string
  original: string
  mimetype: string
  statuscode: string
  digest: string
  length: string
}

const DEFAULT_COUNT = 5

/** Convert ISO date "2010-01-01" to CDX yyyymmddhhmmss. */
function isoToCdxStamp(iso: string, end = false): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error(`wayback: invalid date "${iso}"`)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return end ? `${y}${m}${day}235959` : `${y}${m}${day}000000`
}

/** Convert CDX timestamp "20100101120000" to ISO datetime. */
export function cdxStampToIso(stamp: string): string {
  if (stamp.length < 14) throw new Error(`wayback: malformed CDX timestamp "${stamp}"`)
  const y = stamp.slice(0, 4)
  const m = stamp.slice(4, 6)
  const d = stamp.slice(6, 8)
  const hh = stamp.slice(8, 10)
  const mm = stamp.slice(10, 12)
  const ss = stamp.slice(12, 14)
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`
}

export function snapshotUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}/${original}`
}

/** Sample `count` evenly-spaced rows from a sorted list. Always includes first and last. */
export function sampleEvenly<T>(rows: T[], count: number): T[] {
  if (rows.length <= count) return [...rows]
  if (count <= 0) return []
  if (count === 1) return [rows[Math.floor((rows.length - 1) / 2)]]
  const out: T[] = []
  const step = (rows.length - 1) / (count - 1)
  for (let i = 0; i < count; i++) {
    out.push(rows[Math.round(i * step)])
  }
  return out
}

/** Parse the CDX JSON response (first row is a header). */
export function parseCdxRows(json: unknown): CdxRow[] {
  if (!Array.isArray(json) || json.length < 2) return []
  // Skip header row.
  const rows = json.slice(1) as unknown[]
  const out: CdxRow[] = []
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 7) continue
    out.push({
      urlkey: String(r[0]),
      timestamp: String(r[1]),
      original: String(r[2]),
      mimetype: String(r[3]),
      statuscode: String(r[4]),
      digest: String(r[5]),
      length: String(r[6]),
    })
  }
  return out
}

/** Discover N evenly-spaced wayback snapshots for a URL. */
export async function discoverWaybackSnapshots(url: string, opts: WaybackOptions = {}): Promise<JobTarget[]> {
  const fetchImpl = opts.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('wayback: no fetch implementation available')

  const count = opts.count ?? DEFAULT_COUNT
  const params = new URLSearchParams({
    url,
    output: 'json',
    // collapse=timestamp:6 dedupes to one capture per month (yyyymm = 6 chars).
    // Without this, CDX returns every capture in the window — which for popular
    // sites is tens of thousands and silently skews `sampleEvenly` if combined
    // with a `limit`. With the collapse, the row count is bounded by the
    // window length in months, so we don't need a limit.
    collapse: 'timestamp:6',
  })
  if (opts.since) params.set('from', isoToCdxStamp(opts.since))
  if (opts.until) params.set('to', isoToCdxStamp(opts.until, true))
  if (opts.status200Only !== false) {
    params.set('filter', 'statuscode:200')
  }

  const resp = await fetchImpl(`${CDX_ENDPOINT}?${params.toString()}`)
  if (!resp.ok) {
    throw new Error(`wayback: CDX returned ${resp.status} for ${url}`)
  }
  const json = await resp.json() as unknown
  const rows = parseCdxRows(json)
  if (rows.length === 0) return []
  // CDX returns chronological order by default. Sample evenly across.
  const sampled = sampleEvenly(rows, count)
  return sampled.map(r => ({
    url,
    snapshotUrl: snapshotUrl(r.timestamp, r.original),
    capturedAt: cdxStampToIso(r.timestamp),
  }))
}

/** Expand a list of seed URLs into wayback targets, in parallel. */
export async function expandWaybackTargets(urls: string[], opts: WaybackOptions = {}): Promise<JobTarget[]> {
  const all = await Promise.all(urls.map(u => discoverWaybackSnapshots(u, opts).catch(() => [] as JobTarget[])))
  return all.flat()
}
