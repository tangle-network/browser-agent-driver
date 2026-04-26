/**
 * Eval-agent runner — bootstraps the measurement layer for Track 2.
 *
 * Three flows: calibration, reproducibility, patches.
 *
 * Usage:
 *   pnpm tsx bench/design/eval/run.ts --tier world-class
 *   pnpm tsx bench/design/eval/run.ts --calibration-only --tier world-class
 *   pnpm tsx bench/design/eval/run.ts --repro --reps 3 --urls https://stripe.com,https://linear.app
 *   pnpm tsx bench/design/eval/run.ts --patches-only --roots audit-results
 *
 * Output:
 *   bench/design/eval/results/<ts>/scorecard.json     — the FlowEnvelopes
 *   bench/design/eval/results/<ts>/<flow>/...         — per-flow artifacts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCalibration } from './calibration.js'
import { evaluateReproducibility } from './reproducibility.js'
import { evaluatePatches } from './patches.js'
import { emptyScorecard, summarize, type DesignAuditScorecard } from './scorecard.js'
import type { Corpus } from './calibration.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CORPUS_PATH = path.join(__dirname, '..', 'corpus.json')

interface CliArgs {
  tier?: string
  reps: number
  urls?: string[]
  calibrationOnly: boolean
  reproOnly: boolean
  patchesOnly: boolean
  roots: string[]
  outDir: string
  generation: number
  writeScorecardPath?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reps: 3,
    calibrationOnly: false,
    reproOnly: false,
    patchesOnly: false,
    roots: [],
    outDir: path.join(__dirname, 'results', `run-${Date.now()}`),
    generation: 1,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tier') args.tier = argv[++i]
    else if (a === '--reps') args.reps = Number(argv[++i])
    else if (a === '--urls') args.urls = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--calibration-only') args.calibrationOnly = true
    else if (a === '--repro' || a === '--reproducibility') args.reproOnly = true
    else if (a === '--patches-only') args.patchesOnly = true
    else if (a === '--roots') args.roots = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--out') args.outDir = argv[++i]
    else if (a === '--generation') args.generation = Number(argv[++i])
    else if (a === '--write-scorecard') args.writeScorecardPath = argv[++i]
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const corpus: Corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf-8'))
  fs.mkdirSync(args.outDir, { recursive: true })

  const scorecard = emptyScorecard(args.generation)

  // Decide which flows to run. If no exclusive flag is set, run all three.
  const runCalib = args.calibrationOnly || (!args.reproOnly && !args.patchesOnly)
  const runRepro = args.reproOnly || (!args.calibrationOnly && !args.patchesOnly)
  const runPatches = args.patchesOnly || (!args.calibrationOnly && !args.reproOnly)

  if (runCalib) {
    console.log(`\n=== Calibration ===`)
    const calibOut = path.join(args.outDir, 'calibration')
    const { flow, sites } = await evaluateCalibration({
      corpus, outputDir: calibOut, tier: args.tier,
    })
    for (const s of sites) {
      const icon = !Number.isFinite(s.score) ? 'SKIP' : s.inRange ? 'PASS' : 'FAIL'
      console.log(`  ${icon}  ${s.url}  score=${Number.isFinite(s.score) ? s.score.toFixed(2) : '—'}  expected=${s.expectedMin}-${s.expectedMax}${s.error ? ` err=${s.error}` : ''}`)
    }
    console.log(`  → flow: ${flow.name} = ${Number.isFinite(flow.score) ? flow.score.toFixed(2) : '—'} (target ${flow.target}) [${flow.status}]`)
    scorecard.flows.push(flow)
  }

  if (runRepro) {
    console.log(`\n=== Reproducibility ===`)
    const reproOut = path.join(args.outDir, 'reproducibility')
    const { flow, sites } = await evaluateReproducibility({
      corpus, outputDir: reproOut, urls: args.urls, reps: args.reps,
    })
    for (const s of sites) {
      console.log(`  ${s.url}  scores=[${s.scores.map(x => x.toFixed(1)).join(',')}]  mean=${s.mean}  stddev=${s.stddev}`)
    }
    console.log(`  → flow: ${flow.name} = ${Number.isFinite(flow.score) ? flow.score.toFixed(2) : '—'} (target ${flow.target}) [${flow.status}]`)
    scorecard.flows.push(flow)
  }

  if (runPatches) {
    console.log(`\n=== Patches ===`)
    // Default to the calibration output if no roots given and we just ran calibration.
    let roots = args.roots
    if (roots.length === 0 && runCalib) roots = [path.join(args.outDir, 'calibration')]
    if (roots.length === 0) roots = [path.resolve('audit-results')]
    const flow = evaluatePatches({ roots })
    console.log(`  → flow: ${flow.name} = ${Number.isFinite(flow.score) ? flow.score.toFixed(2) : '—'} (target ${flow.target}) [${flow.status}]  ${flow.notes}`)
    scorecard.flows.push(flow)
  }

  scorecard.summary = summarize(scorecard.flows)

  const cardPath = path.join(args.outDir, 'scorecard.json')
  fs.writeFileSync(cardPath, JSON.stringify(scorecard, null, 2))
  console.log(`\nScorecard → ${cardPath}`)
  console.log(`  pass=${scorecard.summary.pass}/${scorecard.summary.total}  unmeasured=${scorecard.summary.unmeasured}`)

  if (args.writeScorecardPath) {
    appendToProjectScorecard(args.writeScorecardPath, scorecard)
    console.log(`  Merged into ${args.writeScorecardPath}`)
  }

  // Exit non-zero if any flow failed (CI signal).
  const anyFail = scorecard.flows.some(f => f.status === 'fail')
  process.exit(anyFail ? 1 : 0)
}

/**
 * Merge the new flows into `.evolve/scorecard.json` without clobbering older
 * flows from prior generations. Append-style: any flow with the same `name`
 * is replaced; everything else is preserved.
 */
function appendToProjectScorecard(scorecardPath: string, fresh: DesignAuditScorecard): void {
  let existing: { flows?: Array<{ name: string }>; [k: string]: unknown } = {}
  if (fs.existsSync(scorecardPath)) {
    try { existing = JSON.parse(fs.readFileSync(scorecardPath, 'utf-8')) } catch { existing = {} }
  }
  const oldFlows = (existing.flows ?? []) as Array<{ name: string }>
  const freshNames = new Set(fresh.flows.map(f => f.name))
  const merged = [
    ...oldFlows.filter(f => !freshNames.has(f.name)),
    ...fresh.flows,
  ]
  const out = {
    ...existing,
    timestamp: fresh.timestamp,
    generation: fresh.generation,
    flows: merged,
  }
  fs.mkdirSync(path.dirname(scorecardPath), { recursive: true })
  fs.writeFileSync(scorecardPath, JSON.stringify(out, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(2)
})
