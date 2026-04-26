/**
 * `bad jobs` — declarative comparative-audit jobs.
 *
 * Subcommands:
 *   bad jobs create --spec <file.json>   # mints a job from a JSON spec, runs it
 *   bad jobs status <jobId> [--json]     # show a job's current state
 *   bad jobs list [--json]               # recent jobs
 *   bad jobs estimate --spec <file.json> # pre-flight cost estimate, no execution
 *
 * The spec file is JSON (no yaml dep). See `JobSpec` in src/jobs/types.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import chalk from 'chalk'
import { cliError } from './cli-ui.js'
import { discoverTargets } from './discover/index.js'

function die(msg: string): never {
  cliError(msg)
  process.exit(1)
}
import {
  createJob,
  runJob,
  loadJob,
  listJobs,
  estimateCost,
  type JobSpec,
  type AuditFn,
} from './jobs/index.js'

interface ParsedArgs {
  spec?: string
  json?: boolean
  jobId?: string
  yes?: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--spec') out.spec = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (!a.startsWith('-') && !out.jobId) out.jobId = a
  }
  return out
}

function readSpec(specPath: string): JobSpec {
  if (!fs.existsSync(specPath)) die(`spec file not found: ${specPath}`)
  const raw = fs.readFileSync(specPath, 'utf-8')
  try {
    return JSON.parse(raw) as JobSpec
  } catch (err) {
    die(`spec file is not valid JSON: ${(err as Error).message}`)
  }
}

export async function runJobsCli(args: string[]): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  const opts = parseArgs(rest)

  if (sub === 'list') return cmdList(opts)
  if (sub === 'status') return cmdStatus(opts)
  if (sub === 'estimate') return cmdEstimate(opts)
  if (sub === 'create') return cmdCreate(opts)
  die(`Unknown subcommand: ${sub}. Use create | list | status | estimate.`)
}

function cmdList(opts: ParsedArgs): void {
  const entries = listJobs()
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }
  if (entries.length === 0) {
    console.log(chalk.dim('No jobs yet. Try `bad jobs create --spec <file>`.'))
    return
  }
  for (const e of entries.slice(0, 50)) {
    const status = e.status === 'completed' ? chalk.green(e.status)
      : e.status === 'failed' || e.status === 'cancelled' ? chalk.red(e.status)
      : e.status === 'partial' ? chalk.yellow(e.status)
      : chalk.dim(e.status)
    console.log(`  ${e.jobId}  ${status}  targets=${e.targetCount}  ${chalk.dim(e.createdAt)}  ${e.label ?? ''}`)
  }
}

function cmdStatus(opts: ParsedArgs): void {
  if (!opts.jobId) die('jobId is required: bad jobs status <jobId>')
  const job = loadJob(opts.jobId)
  if (!job) die(`job not found: ${opts.jobId}`)
  if (opts.json) {
    console.log(JSON.stringify(job, null, 2))
    return
  }
  const ok = job.results.filter(r => r.status === 'ok').length
  const failed = job.results.filter(r => r.status === 'failed').length
  console.log(`  ${chalk.bold(job.jobId)}  ${chalk.dim(job.status)}`)
  if (job.spec.label) console.log(`  label: ${job.spec.label}`)
  console.log(`  targets: ${job.targets.length}  ·  ok: ${ok}  ·  failed: ${failed}`)
  console.log(`  cost: $${job.totalCostUSD.toFixed(2)}`)
  console.log(`  created: ${job.createdAt}`)
  if (job.completedAt) console.log(`  completed: ${job.completedAt}`)
}

async function cmdEstimate(opts: ParsedArgs): Promise<void> {
  if (!opts.spec) die('--spec is required for estimate')
  const spec = readSpec(opts.spec)
  const targets = await discoverTargets(spec.discover)
  const est = estimateCost(spec, targets.length)
  if (opts.json) {
    console.log(JSON.stringify({ spec, ...est }, null, 2))
    return
  }
  console.log(`  Targets: ${est.targetCount}`)
  console.log(`  Per-audit: $${est.perAuditUSD.toFixed(2)}`)
  console.log(`  Estimated total: $${est.estimatedTotalUSD.toFixed(2)}`)
  if (est.exceedsCap && spec.maxCostUSD !== undefined) {
    console.log(chalk.yellow(`  ⚠ exceeds cap of $${spec.maxCostUSD.toFixed(2)}`))
  }
}

async function cmdCreate(opts: ParsedArgs): Promise<void> {
  if (!opts.spec) die('--spec is required: bad jobs create --spec <file.json>')
  const spec = readSpec(opts.spec)
  const targets = await discoverTargets(spec.discover)
  if (targets.length === 0) die('discover yielded zero targets — check your URLs / wayback range')
  const est = estimateCost(spec, targets.length)
  console.log(`  Targets discovered: ${targets.length}`)
  console.log(`  Estimated cost: $${est.estimatedTotalUSD.toFixed(2)}`)
  if (est.exceedsCap && spec.maxCostUSD !== undefined) {
    die(`Estimated cost $${est.estimatedTotalUSD.toFixed(2)} exceeds maxCostUSD $${spec.maxCostUSD.toFixed(2)}. Raise the cap or shrink the job.`)
  }

  const job = createJob(spec, targets)
  console.log(`  Created job ${chalk.bold(job.jobId)}`)

  const auditFn = await buildAuditFn(spec)
  await runJob(job, { auditFn })
  const final = loadJob(job.jobId)
  console.log(`  Status: ${chalk.bold(final?.status ?? 'unknown')}  ·  ok: ${final?.results.filter(r => r.status === 'ok').length ?? 0}/${final?.targets.length ?? 0}  ·  $${final?.totalCostUSD.toFixed(2)}`)
}

/**
 * Wire the runner to the design-audit pipeline. Imported lazily so `bad jobs
 * list` doesn't pull in Playwright. Each target gets its own output dir so
 * we can deterministically locate `report.json` after the audit returns.
 */
async function buildAuditFn(_spec: JobSpec): Promise<AuditFn> {
  const { runDesignAudit } = await import('./cli-design-audit.js')
  let counter = 0
  return async (target, opts) => {
    const url = target.snapshotUrl ?? target.url
    counter += 1
    const slug = `${slugify(url)}-${Date.now()}-${counter}`
    const outputDir = path.join('audit-results', 'jobs', slug)
    await runDesignAudit({
      url,
      pages: opts?.pages ?? 1,
      output: outputDir,
      json: true,
      headless: opts?.headless ?? true,
      audience: opts?.audience?.join(','),
      audienceVulnerability: opts?.audienceVulnerability?.join(','),
      modality: opts?.modality,
      regulatoryContext: opts?.regulatoryContext?.join(','),
      skipEthics: opts?.skipEthics,
    })
    const reportJson = path.resolve(outputDir, 'report.json')
    if (!fs.existsSync(reportJson)) {
      throw new Error(`audit completed but report.json missing at ${reportJson}`)
    }
    const data = JSON.parse(fs.readFileSync(reportJson, 'utf-8')) as {
      pages?: Array<{
        score?: number
        auditResultV2?: { rollup?: { score?: number }; classification?: { type?: string } }
        rollup?: { score?: number }
        classification?: { type?: string }
      }>
    }
    const page = data.pages?.[0]
    const rollupScore = page?.auditResultV2?.rollup?.score ?? page?.rollup?.score ?? page?.score
    const pageType = page?.auditResultV2?.classification?.type ?? page?.classification?.type
    return {
      runId: outputDir, // The output dir is the de-facto runId for jobs.
      resultPath: reportJson,
      rollupScore,
      pageType,
    }
  }
}

function slugify(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase()
}
