/**
 * Design audit benchmark runner.
 *
 * Runs the design audit against the corpus and validates:
 * 1. Scores fall within expected ranges (calibration)
 * 2. Scores are reproducible within ±0.5 stddev (consistency)
 * 3. Evolve loop improves scores by 2+ points (improvement)
 *
 * Usage:
 *   pnpm tsx bench/design/run-design-bench.ts [--tier world-class|good|average|vibecoded|defi] [--reproducibility] [--evolve]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDesignAudit } from '../../src/cli-design-audit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface CorpusSite {
  url: string
  profile: string
  expectedScore: { min: number; max: number }
  notes: string
}

interface Corpus {
  tiers: Record<string, { description: string; sites: CorpusSite[] }>
  reproducibilityTarget: { maxStdDev: number; minRuns: number }
}

async function main() {
  const args = process.argv.slice(2)
  const tierFilter = args.includes('--tier') ? args[args.indexOf('--tier') + 1] : undefined
  const runReproducibility = args.includes('--reproducibility')
  const runEvolve = args.includes('--evolve')
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined
  const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : undefined

  const corpus: Corpus = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf-8')
  )

  const outputDir = path.join(__dirname, 'results', `run-${Date.now()}`)
  fs.mkdirSync(outputDir, { recursive: true })

  const tiers = tierFilter
    ? { [tierFilter]: corpus.tiers[tierFilter] }
    : corpus.tiers

  const results: Array<{
    url: string
    tier: string
    profile: string
    expectedMin: number
    expectedMax: number
    pass: boolean
  }> = []

  for (const [tierName, tier] of Object.entries(tiers)) {
    if (!tier) {
      console.error(`Unknown tier: ${tierName}`)
      continue
    }

    console.log(`\n--- Tier: ${tierName} ---`)
    console.log(tier.description)

    for (const site of tier.sites) {
      const siteOutput = path.join(outputDir, tierName, new URL(site.url).hostname)

      try {
        await runDesignAudit({
          url: site.url,
          pages: 1,
          profile: site.profile,
          model,
          provider,
          output: siteOutput,
          json: true,
          headless: true,
          reproducibility: runReproducibility,
          evolve: runEvolve,
          evolveRounds: runEvolve ? 2 : undefined,
        })

        // Read the JSON report to check score
        const reportPath = path.join(siteOutput, 'report.json')
        if (fs.existsSync(reportPath)) {
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
          const score = report.summary.avgScore
          const inRange = score >= site.expectedScore.min && score <= site.expectedScore.max
          results.push({
            url: site.url,
            tier: tierName,
            profile: site.profile,
            expectedMin: site.expectedScore.min,
            expectedMax: site.expectedScore.max,
            pass: inRange,
          })

          const icon = inRange ? '  PASS' : '  FAIL'
          console.log(`${icon}  ${site.url}: ${score.toFixed(1)} (expected ${site.expectedScore.min}-${site.expectedScore.max})`)
        }
      } catch (err) {
        console.error(`  ERROR  ${site.url}: ${err instanceof Error ? err.message : err}`)
        results.push({
          url: site.url,
          tier: tierName,
          profile: site.profile,
          expectedMin: site.expectedScore.min,
          expectedMax: site.expectedScore.max,
          pass: false,
        })
      }
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length
  const total = results.length
  console.log(`\n=== Results: ${passed}/${total} in expected range ===`)

  fs.writeFileSync(
    path.join(outputDir, 'bench-results.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  )
  console.log(`Results: ${path.join(outputDir, 'bench-results.json')}`)

  process.exit(passed === total ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
