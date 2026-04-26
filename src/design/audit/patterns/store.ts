/**
 * Layer 5 — Pattern store.
 *
 * Reads/writes patterns from a JSONL file. In production this is backed by a
 * Cloudflare D1 or R2 store; the JSONL backend is for local dev and tests.
 *
 * Cold-start: the pattern library is empty until fleet data accumulates.
 * The store returns [] for all queries until patterns are mined (Layer 5 mine.ts).
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Pattern, PatternQuery } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), '.bad', 'patterns')
const PATTERNS_FILE = 'patterns.jsonl'

export async function loadPatterns(dir: string = DEFAULT_DIR): Promise<Pattern[]> {
  const filePath = path.join(dir, PATTERNS_FILE)
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
  return lines.flatMap(line => {
    try { return [JSON.parse(line) as Pattern] }
    catch { return [] }
  })
}

export async function savePattern(pattern: Pattern, dir: string = DEFAULT_DIR): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.appendFile(path.join(dir, PATTERNS_FILE), JSON.stringify(pattern) + '\n', 'utf-8')
}

export async function queryPatterns(
  query: PatternQuery,
  dir: string = DEFAULT_DIR,
): Promise<Pattern[]> {
  const all = await loadPatterns(dir)
  return all.filter(p => {
    if (query.category && p.category !== query.category) return false
    if (query.pageType && p.classification.type !== query.pageType) return false
    if (query.minApplications && p.fleetEvidence.applications < query.minApplications) return false
    if (query.minSuccessRate && p.fleetEvidence.successRate < query.minSuccessRate) return false
    if (query.weakDimension) {
      const delta = p.fleetEvidence.medianDimDelta[query.weakDimension] ?? 0
      if (delta <= 0) return false
    }
    return true
  })
}
