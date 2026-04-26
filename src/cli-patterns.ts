/**
 * Layer 5 — `bad patterns` subcommand surface.
 *
 * Provides pattern query and inspection via CLI. Mining runs as a periodic
 * Cloudflare Worker cron in production; locally it reads from ~/.bad/patterns/.
 *
 *   bad patterns query [--category <cat>] [--page-type <type>] [--weak-dimension <dim>]
 *   bad patterns show <patternId>
 *   bad patterns mine [--dir <path>]
 */

import type { PatternQuery } from './design/audit/patterns/types.js'
import { queryPatterns, loadPatterns } from './design/audit/patterns/store.js'
import type { Dimension, PageType } from './design/audit/v2/types.js'

export interface PatternsQueryOptions {
  category?: string
  pageType?: PageType
  weakDimension?: Dimension
  minApplications?: number
  minSuccessRate?: number
  json?: boolean
  dir?: string
}

export async function runPatternsQuery(opts: PatternsQueryOptions): Promise<void> {
  const query: PatternQuery = {
    category: opts.category,
    pageType: opts.pageType,
    weakDimension: opts.weakDimension,
    minApplications: opts.minApplications,
    minSuccessRate: opts.minSuccessRate,
  }
  const patterns = await queryPatterns(query, opts.dir)

  if (patterns.length === 0) {
    console.log('No patterns found. The pattern library is empty until fleet data accumulates (Layer 5 cold-start).')
    return
  }

  if (opts.json) {
    console.log(JSON.stringify(patterns, null, 2))
    return
  }

  for (const p of patterns) {
    console.log(`\n[${p.patternId}] ${p.scaffold.description}`)
    console.log(`  Category: ${p.category} | Type: ${p.classification.type}`)
    console.log(`  Fleet: N=${p.fleetEvidence.applications} tenants=${p.fleetEvidence.sampleTenants} success=${(p.fleetEvidence.successRate * 100).toFixed(0)}%`)
    console.log(`  Key decisions: ${p.scaffold.keyDecisions.join('; ')}`)
  }
}

export async function runPatternsShow(patternId: string, opts: { json?: boolean; dir?: string } = {}): Promise<void> {
  const all = await loadPatterns(opts.dir)
  const pattern = all.find(p => p.patternId === patternId)
  if (!pattern) {
    console.error(`Pattern ${patternId} not found.`)
    process.exit(1)
  }
  if (opts.json) {
    console.log(JSON.stringify(pattern, null, 2))
    return
  }
  console.log(JSON.stringify(pattern, null, 2))
}
