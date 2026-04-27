/**
 * Reproducibility evaluator: same site, N runs — does the rollup score wobble?
 *
 * Target: max stddev across all sites ≤ 0.5. The corpus declares this:
 *   reproducibilityTarget: { maxStdDev: 0.5, minRuns: 3 }
 *
 * Runs are independent — concurrency=1 to keep variance honest (parallel
 * Playwright sessions share a Chromium pool that can introduce timing
 * coupling).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { FlowEnvelope } from './scorecard.js'
import { statusFor } from './scorecard.js'
import type { Corpus } from './calibration.js'
import { runDesignAudit } from '../../../src/cli-design-audit.js'

export interface ReproOptions {
  corpus: Corpus
  outputDir: string
  /** Subset of URLs to test. Defaults to all world-class sites (cheapest meaningful). */
  urls?: string[]
  reps?: number
  /** Pass/fail threshold on max stddev. Default 0.5. */
  target?: number
}

export interface SiteRepro {
  url: string
  scores: number[]
  mean: number
  stddev: number
}

const FLOW_NAME = 'designAudit_reproducibility_max_stddev'

export async function evaluateReproducibility(opts: ReproOptions): Promise<{ flow: FlowEnvelope; sites: SiteRepro[] }> {
  const target = opts.target ?? opts.corpus.reproducibilityTarget?.maxStdDev ?? 0.5
  const reps = opts.reps ?? opts.corpus.reproducibilityTarget?.minRuns ?? 3
  const urls = opts.urls ?? defaultUrls(opts.corpus)
  fs.mkdirSync(opts.outputDir, { recursive: true })

  const sites: SiteRepro[] = []
  for (const url of urls) {
    const scores: number[] = []
    for (let r = 0; r < reps; r++) {
      const dir = path.join(opts.outputDir, new URL(url).hostname, `rep-${r + 1}`)
      try {
        await runDesignAudit({ url, pages: 1, output: dir, json: true, headless: true })
        const reportJson = path.join(dir, 'report.json')
        if (!fs.existsSync(reportJson)) continue
        const data = JSON.parse(fs.readFileSync(reportJson, 'utf-8')) as {
          pages?: Array<{ score?: number; rollup?: { score?: number }; auditResult?: { rollup?: { score?: number } } }>
        }
        const page = data.pages?.[0]
        const score = page?.auditResult?.rollup?.score ?? page?.rollup?.score ?? page?.score
        if (typeof score === 'number' && Number.isFinite(score)) scores.push(score)
      } catch {
        // skip failed reps; computed mean/stddev is over the survivors
      }
    }
    if (scores.length === 0) continue
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    const stddev = Math.sqrt(scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / scores.length)
    sites.push({ url, scores, mean: round2(mean), stddev: round2(stddev) })
  }

  // The flow score IS the max stddev — lower is better.
  const maxStddev = sites.length === 0 ? NaN : Math.max(...sites.map(s => s.stddev))
  const flow: FlowEnvelope = {
    name: FLOW_NAME,
    description: `Maximum stddev of design-audit rollup across ${reps} reps per site. Lower is better.`,
    score: maxStddev,
    target,
    comparator: '<=',
    status: statusFor(maxStddev, target, '<='),
    notes: `${sites.length} sites × ${reps} reps. ${sites.map(s => `${new URL(s.url).hostname}=${s.stddev}`).join(', ')}`,
    artifact: opts.outputDir,
    detail: { sites, reps, target },
  }
  return { flow, sites }
}

function defaultUrls(corpus: Corpus): string[] {
  // World-class tier is the cheapest meaningful set: 5 sites known to be
  // well-rendered, so reps don't get poisoned by anti-bot or 404.
  const tier = corpus.tiers['world-class']
  if (!tier) return []
  return tier.sites.map(s => s.url)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
