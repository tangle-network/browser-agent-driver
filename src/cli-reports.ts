/**
 * `bad reports generate` — produce a markdown artifact from a job's results.
 *
 *   bad reports generate --job <id> --template <leaderboard|longitudinal|batch-comparison>
 *     [--out <file>] [--top <N>] [--by-type <type>] [--buckets 10,100,200]
 *     [--narrate] [--context "...one-line context for the LLM..."]
 *
 * The report is the deterministic body. `--narrate` prepends an LLM exec
 * summary; without it, the artifact is pure data.
 */

import * as fs from 'node:fs'
import chalk from 'chalk'
import { cliError } from './cli-ui.js'
import { loadJob } from './jobs/index.js'

function die(msg: string): never {
  cliError(msg)
  process.exit(1)
}
import {
  aggregateJob,
  renderLeaderboard,
  renderLongitudinal,
  renderBatchComparison,
  renderJobHeader,
  narrateReport,
} from './reports/index.js'

interface ReportArgs {
  job?: string
  template?: string
  out?: string
  top?: number
  byType?: string
  buckets?: number[]
  narrate?: boolean
  context?: string
  json?: boolean
}

function parseArgs(argv: string[]): ReportArgs {
  const out: ReportArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--job') out.job = argv[++i]
    else if (a === '--template') out.template = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--top') out.top = Number(argv[++i])
    else if (a === '--by-type') out.byType = argv[++i]
    else if (a === '--buckets') out.buckets = argv[++i].split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n))
    else if (a === '--narrate') out.narrate = true
    else if (a === '--context') out.context = argv[++i]
    else if (a === '--json') out.json = true
  }
  return out
}

const TEMPLATES = new Set(['leaderboard', 'longitudinal', 'batch-comparison'])

export async function runReportsCli(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub !== 'generate') die(`Unknown subcommand: ${sub}. Use generate.`)
  const opts = parseArgs(args.slice(1))
  if (!opts.job) die('--job is required')
  if (!opts.template) die('--template is required (leaderboard | longitudinal | batch-comparison)')
  if (!TEMPLATES.has(opts.template)) die(`Unknown template: ${opts.template}. Valid: ${[...TEMPLATES].join(', ')}`)

  const job = loadJob(opts.job)
  if (!job) die(`job not found: ${opts.job}`)

  const rows = aggregateJob(job)

  let body: string
  if (opts.template === 'leaderboard') {
    body = renderLeaderboard(rows, { topN: opts.top, byType: opts.byType, buckets: opts.buckets })
  } else if (opts.template === 'longitudinal') {
    body = renderLongitudinal(rows)
  } else {
    body = renderBatchComparison(rows)
  }

  const header = renderJobHeader(job) + '\n\n---\n\n'
  let final = header + body

  if (opts.narrate) {
    try {
      const { Brain } = await import('./brain/index.js')
      const brain = new Brain()
      final = await narrateReport(final, { brain, context: opts.context })
    } catch (err) {
      console.warn(chalk.yellow(`narrate failed, falling back to deterministic body: ${(err as Error).message}`))
    }
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, final, 'utf-8')
    console.log(`  Report written → ${opts.out}`)
  } else if (opts.json) {
    console.log(JSON.stringify({ jobId: job.jobId, template: opts.template, markdown: final }, null, 2))
  } else {
    console.log(final)
  }
}
