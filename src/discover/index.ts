/**
 * Discoverers — turn a job's `discover` spec into a flat list of audit targets.
 *
 * Two sources:
 *   list     — explicit URLs (passthrough).
 *   wayback  — expand each URL into N historical snapshots via the CDX API.
 */

import type { DiscoverSpec, JobTarget } from '../jobs/types.js'
import { expandWaybackTargets, type WaybackOptions } from './wayback.js'

export { discoverWaybackSnapshots, expandWaybackTargets, snapshotUrl, sampleEvenly, parseCdxRows, cdxStampToIso } from './wayback.js'
export type { WaybackOptions } from './wayback.js'

export interface DiscoverOptions {
  /** Injected fetch (tests). */
  fetch?: typeof fetch
}

export async function discoverTargets(spec: DiscoverSpec, opts: DiscoverOptions = {}): Promise<JobTarget[]> {
  if (spec.source === 'list') {
    return spec.urls.map(url => ({ url }))
  }
  if (spec.source === 'wayback') {
    const wb: WaybackOptions = {
      count: spec.snapshotsPerUrl,
      since: spec.since,
      until: spec.until,
      fetch: opts.fetch,
    }
    return expandWaybackTargets(spec.urls, wb)
  }
  throw new Error(`discover: unsupported source "${(spec as DiscoverSpec).source}"`)
}
