/**
 * Layer 5 — Pattern mining (scaffold).
 *
 * In production this runs as a Cloudflare Worker cron job on accumulated
 * PatchApplication telemetry. The mining threshold (N≥30, ≥5 tenants,
 * replicationRate≥0.7) prevents false patterns from premature data.
 *
 * Until fleet data accumulates this module is a scaffold. Run:
 *   pnpm patterns:mine --dir ~/.bad
 *
 * TODO: implement clustering algorithm once sufficient attribution data exists.
 */

import type { PatchApplication } from '../attribution/types.js'
import type { Pattern } from './types.js'
import { savePattern } from './store.js'

export interface MineOptions {
  minApplications?: number
  minTenants?: number
  minReplicationRate?: number
  dir?: string
}

const DEFAULTS: Required<Omit<MineOptions, 'dir'>> = {
  minApplications: 30,
  minTenants: 5,
  minReplicationRate: 0.7,
}

/**
 * Mine patterns from accumulated PatchApplication records.
 *
 * Currently a stub — returns 0 mined until clustering is implemented.
 * The interface is stable; consumers can call it safely in tests via synthetic
 * data without triggering real fleet operations.
 */
export async function minePatterns(
  applications: PatchApplication[],
  opts: MineOptions = {},
): Promise<{ mined: number; skipped: number }> {
  void applications
  void opts
  void DEFAULTS
  void savePattern
  // TODO: implement structural clustering by (scope, target.cssSelector pattern,
  // diff similarity) once N≥30 fleet data is available. See RFC §Layer 5.
  return { mined: 0, skipped: applications.length }
}
