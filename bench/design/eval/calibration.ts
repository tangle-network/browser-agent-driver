/**
 * Calibration evaluator: do design-audit scores land in expected per-tier ranges?
 *
 * Ground truth: `bench/design/corpus.json` declares for each site an
 * `expectedScore: { min, max }` range based on a human prior ("Stripe is
 * world-class, expect 8-10"). The eval runs each site, reads the rollup
 * score, and computes the fraction-in-range.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FlowEnvelope } from './scorecard.js'
import { statusFor } from './scorecard.js'
import { runDesignAudit } from '../../../src/cli-design-audit.js'

export interface CorpusSite {
  url: string
  profile: string
  expectedScore: { min: number; max: number }
  notes?: string
}

export interface Corpus {
  tiers: Record<string, { description: string; sites: CorpusSite[] }>
  reproducibilityTarget?: { maxStdDev: number; minRuns: number }
}

export interface CalibrationOptions {
  corpus: Corpus
  outputDir: string
  /** Restrict to one tier (e.g. 'world-class'). Default: all tiers. */
  tier?: string
  /** Minimum target for the in-range rate. Default 0.7 (70% of sites in range). */
  target?: number
  /** Skip sites we already have results for in `outputDir`. Defaults true so a partial run can resume. */
  resume?: boolean
}

export interface SiteResult {
  url: string
  tier: string
  expectedMin: number
  expectedMax: number
  /** Audit rollup score, NaN on failure / blocked. */
  score: number
  inRange: boolean
  error?: string
}

const FLOW_NAME = 'designAudit_calibration_in_range_rate'

/**
 * Run the corpus, compute fraction-in-range, and emit one FlowEnvelope.
 */
export async function evaluateCalibration(opts: CalibrationOptions): Promise<{ flow: FlowEnvelope; sites: SiteResult[] }> {
  const target = opts.target ?? 0.7
  const tiers = opts.tier ? { [opts.tier]: opts.corpus.tiers[opts.tier] } : opts.corpus.tiers
  const sites: SiteResult[] = []
  fs.mkdirSync(opts.outputDir, { recursive: true })

  for (const [tierName, tier] of Object.entries(tiers)) {
    if (!tier) continue
    for (const site of tier.sites) {
      const siteOut = path.join(opts.outputDir, tierName, new URL(site.url).hostname)
      const reportJson = path.join(siteOut, 'report.json')
      let score = NaN
      let error: string | undefined
      if (opts.resume !== false && fs.existsSync(reportJson)) {
        try {
          score = readScore(reportJson)
        } catch (err) {
          error = (err as Error).message
        }
      } else {
        try {
          await runDesignAudit({
            url: site.url, pages: 1, profile: site.profile,
            output: siteOut, json: true, headless: true,
          })
          score = readScore(reportJson)
        } catch (err) {
          error = (err as Error).message
        }
      }
      const inRange = Number.isFinite(score) && score >= site.expectedScore.min && score <= site.expectedScore.max
      sites.push({ url: site.url, tier: tierName, expectedMin: site.expectedScore.min, expectedMax: site.expectedScore.max, score, inRange, error })
    }
  }

  const measurable = sites.filter(s => Number.isFinite(s.score))
  const inRangeCount = measurable.filter(s => s.inRange).length
  const score = measurable.length === 0 ? NaN : inRangeCount / measurable.length

  const flow: FlowEnvelope = {
    name: FLOW_NAME,
    description: 'Fraction of corpus sites whose design-audit rollup falls inside the human-declared expected range.',
    score,
    target,
    comparator: '>=',
    status: statusFor(score, target, '>='),
    notes: `${inRangeCount}/${measurable.length} sites in range, ${sites.length - measurable.length} failed/skipped. Per-tier: ${tierBreakdown(sites)}`,
    artifact: opts.outputDir,
    detail: { sites, target, tier: opts.tier ?? 'all' },
  }
  return { flow, sites }
}

function readScore(reportJson: string): number {
  const data = JSON.parse(fs.readFileSync(reportJson, 'utf-8')) as {
    pages?: Array<{ score?: number; rollup?: { score?: number }; auditResult?: { rollup?: { score?: number } } }>
    summary?: { avgScore?: number }
  }
  const page = data.pages?.[0]
  if (!page) throw new Error('report.json has no pages[]')
  // Prefer the auditResult rollup, fall back to v1 page.score / summary.avgScore.
  return page.auditResult?.rollup?.score
    ?? page.rollup?.score
    ?? page.score
    ?? data.summary?.avgScore
    ?? NaN
}

function tierBreakdown(sites: SiteResult[]): string {
  const byTier = new Map<string, { ok: number; total: number }>()
  for (const s of sites) {
    if (!byTier.has(s.tier)) byTier.set(s.tier, { ok: 0, total: 0 })
    const b = byTier.get(s.tier)!
    b.total += 1
    if (s.inRange) b.ok += 1
  }
  return Array.from(byTier.entries()).map(([t, b]) => `${t} ${b.ok}/${b.total}`).join(', ')
}
