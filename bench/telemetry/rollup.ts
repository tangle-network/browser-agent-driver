/**
 * Fleet telemetry rollup.
 *
 * Reads `~/.bad/telemetry/<repo>/<date>.jsonl` (or whatever
 * BAD_TELEMETRY_DIR points at), groups by (repo, kind), and prints a
 * compact summary plus a JSON dump suitable for piping into a dashboard.
 *
 * The point of this script is twofold:
 *   1. Make the data the system is collecting visible to the user.
 *   2. Surface regressions: per-repo trend in avgScore / criticalFindings,
 *      per-prompt-hash variance, evolve win rate.
 *
 *   pnpm telemetry:rollup
 *   pnpm telemetry:rollup --since 2026-04-01 --repo browser-agent-driver
 *   pnpm telemetry:rollup --json > rollup.json
 *
 * Designed to read raw envelopes — it does NOT depend on agent-eval. When we
 * upstream to agent-eval we'll add a TraceStore adapter that reads the same
 * directory.
 */

import { parseArgs } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { TelemetryEnvelope } from '../../src/telemetry/schema.js'

interface CliArgs {
  baseDir: string
  since?: string
  until?: string
  repo?: string
  kind?: string
  json: boolean
  /** Print individual envelopes instead of group rollups. */
  raw: boolean
  /**
   * When true, query the fleet collector at BAD_TELEMETRY_API instead of
   * reading local files. Errors out if BAD_TELEMETRY_API or
   * BAD_TELEMETRY_ADMIN_BEARER is not set.
   */
  remote: boolean
  /** Exit non-zero when agent telemetry has structural integrity findings. */
  failOnAgentIntegrity: boolean
}

async function main(): Promise<void> {
  const args = parseCliArgs()

  if (args.remote) {
    await runRemote(args)
    return
  }

  if (!fs.existsSync(args.baseDir)) {
    console.error(`[rollup] no telemetry dir found: ${args.baseDir}`)
    console.error(`[rollup] run a 'bad design-audit' first, or set BAD_TELEMETRY_DIR.`)
    process.exit(1)
  }

  const envelopes = readAll(args.baseDir)
  const filtered = envelopes.filter((e) => keep(e, args))

  if (args.raw) {
    for (const env of filtered) console.log(JSON.stringify(env))
    return
  }

  const summary = aggregate(filtered)
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    failOnAgentIntegrity(summary, args)
    return
  }
  printSummary(summary, filtered.length, args)
  failOnAgentIntegrity(summary, args)
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      repo: { type: 'string' },
      kind: { type: 'string' },
      json: { type: 'boolean' },
      raw: { type: 'boolean' },
      remote: { type: 'boolean' },
      'fail-on-agent-integrity': { type: 'boolean' },
    },
  })
  if (values.raw && values['fail-on-agent-integrity']) {
    console.error('[rollup] --fail-on-agent-integrity cannot be used with --raw because raw mode has no summary.')
    process.exit(2)
  }
  const remote = !!values.remote
  if (remote) {
    if (!process.env.BAD_TELEMETRY_API) {
      console.error('[rollup] --remote requires BAD_TELEMETRY_API to be set (e.g. https://bad-app.example.com).')
      process.exit(2)
    }
    if (!process.env.BAD_TELEMETRY_ADMIN_BEARER) {
      console.error('[rollup] --remote requires BAD_TELEMETRY_ADMIN_BEARER to be set.')
      process.exit(2)
    }
  }
  return {
    baseDir: values.dir ?? process.env.BAD_TELEMETRY_DIR ?? path.join(os.homedir(), '.bad', 'telemetry'),
    ...(values.since ? { since: values.since } : {}),
    ...(values.until ? { until: values.until } : {}),
    ...(values.repo ? { repo: values.repo } : {}),
    ...(values.kind ? { kind: values.kind } : {}),
    json: !!values.json,
    raw: !!values.raw,
    remote,
    failOnAgentIntegrity: !!values['fail-on-agent-integrity'],
  }
}

interface AgentIntegrityFinding {
  repo: string
  runId: string
  issueCodes: string[]
  stepCount: number
  hasRunSummary: boolean
  modelCallCount: number
  inputTokens: number
  outputTokens: number
}

interface RemoteRollup {
  byRepoKind: unknown[]
  byEvolveOutcome: unknown[]
  byPromptHash: unknown[]
  recentRegressions: unknown[]
  agentIntegrity?: AgentIntegrityFinding[]
  totals: { repos: number; totalEnvelopes: number; distinctRuns: number; distinctRepos: string[] }
  truncated?: boolean
}

async function runRemote(args: CliArgs): Promise<void> {
  const base = process.env.BAD_TELEMETRY_API!.replace(/\/$/, '')
  const bearer = process.env.BAD_TELEMETRY_ADMIN_BEARER!

  // --raw streams individual envelopes via the /envelopes endpoint with cursor
  // pagination so large fleet data doesn't have to fit in one response.
  if (args.raw) {
    let cursor: string | undefined
    while (true) {
      const url = buildRemoteUrl(`${base}/api/telemetry/v1/envelopes`, args, cursor)
      const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
      if (!res.ok) {
        console.error(`[rollup] remote /envelopes failed: ${res.status} ${await res.text().catch(() => '')}`)
        process.exit(1)
      }
      const body = (await res.json()) as { envelopes: TelemetryEnvelope[]; cursor?: string }
      for (const env of body.envelopes) console.log(JSON.stringify(env))
      if (!body.cursor) break
      cursor = body.cursor
    }
    return
  }

  const url = buildRemoteUrl(`${base}/api/telemetry/v1/rollup`, args)
  const res = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })
  if (!res.ok) {
    console.error(`[rollup] remote /rollup failed: ${res.status} ${await res.text().catch(() => '')}`)
    process.exit(1)
  }
  const summary = (await res.json()) as RemoteRollup
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    failOnAgentIntegrity(summary, args)
    return
  }
  printSummary(summary as unknown as RolledUp, summary.totals.totalEnvelopes, args)
  if (summary.truncated) {
    console.log()
    console.log('⚠ rollup truncated at server cap (5000 envelopes scanned). Use --since/--until to narrow.')
  }
  failOnAgentIntegrity(summary, args)
}

function buildRemoteUrl(base: string, args: CliArgs, cursor?: string): string {
  const u = new URL(base)
  if (args.repo) u.searchParams.set('repo', args.repo)
  if (args.kind) u.searchParams.set('kind', args.kind)
  if (args.since) u.searchParams.set('since', args.since)
  if (args.until) u.searchParams.set('until', args.until)
  if (cursor) u.searchParams.set('cursor', cursor)
  return u.toString()
}

function readAll(baseDir: string): TelemetryEnvelope[] {
  const out: TelemetryEnvelope[] = []
  for (const entry of fs.readdirSync(baseDir)) {
    const repoDir = path.join(baseDir, entry)
    const stat = fs.statSync(repoDir)
    if (!stat.isDirectory()) continue
    for (const file of fs.readdirSync(repoDir)) {
      if (!file.endsWith('.jsonl')) continue
      const lines = fs.readFileSync(path.join(repoDir, file), 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as TelemetryEnvelope)
        } catch {
          /* skip malformed lines — never fail the rollup on a corrupt write */
        }
      }
    }
  }
  return out
}

function keep(env: TelemetryEnvelope, args: CliArgs): boolean {
  if (args.repo && env.source.repo !== args.repo) return false
  if (args.kind && env.kind !== args.kind) return false
  if (args.since && env.timestamp < args.since) return false
  if (args.until && env.timestamp > args.until) return false
  return true
}

interface RolledUp {
  byRepoKind: Array<{
    repo: string
    kind: string
    runs: number
    okRate: number
    avgDurationMs: number
    avgScore: number | null
    avgFindings: number | null
    avgCritical: number | null
    avgTokens: number | null
    avgInputTokens: number | null
    avgOutputTokens: number | null
    avgCacheReadInputTokens: number | null
    avgCacheCreationInputTokens: number | null
    avgEstimatedCostUsd: number | null
    avgModelCalls: number | null
    avgToolCalls: number | null
    avgExecuteFailures: number | null
    avgVerificationRejections: number | null
    avgDecisionSkips: number | null
    avgSnapshotBytes: number | null
    avgScreenshotBytes: number | null
    earliestTs: string
    latestTs: string
  }>
  byEvolveOutcome: Array<{
    repo: string
    runs: number
    avgInitialScore: number
    avgFinalScore: number
    avgDelta: number
    convergedRate: number
  }>
  byPromptHash: Array<{
    promptHash: string
    runs: number
    avgScore: number
    avgFindings: number
  }>
  recentRegressions: Array<{
    repo: string
    kind: string
    timestamp: string
    metric: string
    delta: number
  }>
  agentIntegrity: AgentIntegrityFinding[]
  totals: {
    repos: number
    totalEnvelopes: number
    distinctRuns: number
    distinctRepos: string[]
  }
}

function aggregate(envelopes: TelemetryEnvelope[]): RolledUp {
  const groups = new Map<string, TelemetryEnvelope[]>()
  for (const env of envelopes) {
    const key = `${env.source.repo}|${env.kind}`
    const list = groups.get(key) ?? []
    list.push(env)
    groups.set(key, list)
  }

  const byRepoKind: RolledUp['byRepoKind'] = []
  for (const [key, list] of groups) {
    const [repo = 'unknown', kind = 'unknown'] = key.split('|')
    const ok = list.filter((e) => e.ok)
    const scores = ok.map((e) => e.metrics.score ?? e.metrics.avgScore).filter(isNum)
    const findings = ok.map((e) => e.metrics.findingCount ?? e.metrics.totalFindings).filter(isNum)
    const critical = ok.map((e) => e.metrics.criticalCount ?? e.metrics.criticalFindings).filter(isNum)
    const tokens = ok.map((e) => e.metrics.tokensUsed).filter(isNum)
    const agentTokenTotals = list
      .map((e) => {
        const input = e.metrics.inputTokens
        const output = e.metrics.outputTokens
        if (!isNum(input) && !isNum(output)) return undefined
        return (isNum(input) ? input : 0) + (isNum(output) ? output : 0)
      })
      .filter(isNum)
    const decisionSkips = list
      .map((e) => {
        const cacheHits = e.metrics.decideCacheHits
        const patternSkips = e.metrics.decidePatternSkips
        if (!isNum(cacheHits) && !isNum(patternSkips)) return undefined
        return (isNum(cacheHits) ? cacheHits : 0) + (isNum(patternSkips) ? patternSkips : 0)
      })
      .filter(isNum)
    const ordered = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    byRepoKind.push({
      repo,
      kind,
      runs: list.length,
      okRate: list.length === 0 ? 0 : ok.length / list.length,
      avgDurationMs: avg(list.map((e) => e.durationMs)),
      avgScore: scores.length > 0 ? round(avg(scores), 2) : null,
      avgFindings: findings.length > 0 ? round(avg(findings), 1) : null,
      avgCritical: critical.length > 0 ? round(avg(critical), 1) : null,
      avgTokens: tokens.length > 0
        ? Math.round(avg(tokens))
        : agentTokenTotals.length > 0
          ? Math.round(avg(agentTokenTotals))
          : null,
      avgInputTokens: avgMetric(list, 'inputTokens', 0),
      avgOutputTokens: avgMetric(list, 'outputTokens', 0),
      avgCacheReadInputTokens: avgMetric(list, 'cacheReadInputTokens', 0),
      avgCacheCreationInputTokens: avgMetric(list, 'cacheCreationInputTokens', 0),
      avgEstimatedCostUsd: avgMetric(list, 'estimatedCostUsd', 6),
      avgModelCalls: avgMetric(list, 'modelCallCount', 1),
      avgToolCalls: avgMetric(list, 'toolCallCount', 1),
      avgExecuteFailures: avgMetric(list, 'executeFailureCount', 1),
      avgVerificationRejections: avgMetric(list, 'verificationRejectionCount', 1),
      avgDecisionSkips: decisionSkips.length > 0 ? round(avg(decisionSkips), 1) : null,
      avgSnapshotBytes: avgMetric(list, 'snapshotBytes', 0),
      avgScreenshotBytes: avgMetric(list, 'screenshotBytes', 0),
      earliestTs: ordered[0]!.timestamp,
      latestTs: ordered[ordered.length - 1]!.timestamp,
    })
  }
  byRepoKind.sort((a, b) => (a.repo + a.kind).localeCompare(b.repo + b.kind))

  const evolveRuns = envelopes.filter((e) => e.kind === 'design-evolve-run' && e.ok)
  const evolveByRepo = new Map<string, TelemetryEnvelope[]>()
  for (const e of evolveRuns) {
    const list = evolveByRepo.get(e.source.repo) ?? []
    list.push(e)
    evolveByRepo.set(e.source.repo, list)
  }
  const byEvolveOutcome: RolledUp['byEvolveOutcome'] = []
  for (const [repo, list] of evolveByRepo) {
    const initial = list.map((e) => e.metrics.initialScore).filter(isNum)
    const finalS = list.map((e) => e.metrics.finalScore).filter(isNum)
    const delta = list.map((e) => e.metrics.delta).filter(isNum)
    const converged = list.filter((e) => (e.metrics.delta ?? 0) > 0.5).length
    byEvolveOutcome.push({
      repo,
      runs: list.length,
      avgInitialScore: round(avg(initial), 2),
      avgFinalScore: round(avg(finalS), 2),
      avgDelta: round(avg(delta), 2),
      convergedRate: list.length === 0 ? 0 : converged / list.length,
    })
  }
  byEvolveOutcome.sort((a, b) => a.repo.localeCompare(b.repo))

  const promptGroups = new Map<string, TelemetryEnvelope[]>()
  for (const env of envelopes) {
    const hash = env.model?.rubricHash ?? env.model?.promptHash
    if (!hash) continue
    const list = promptGroups.get(hash) ?? []
    list.push(env)
    promptGroups.set(hash, list)
  }
  const byPromptHash: RolledUp['byPromptHash'] = []
  for (const [hash, list] of promptGroups) {
    if (list.length < 2) continue
    const scores = list.map((e) => e.metrics.score).filter(isNum)
    const findings = list.map((e) => e.metrics.findingCount).filter(isNum)
    if (scores.length === 0) continue
    byPromptHash.push({
      promptHash: hash,
      runs: list.length,
      avgScore: round(avg(scores), 2),
      avgFindings: round(avg(findings), 1),
    })
  }
  byPromptHash.sort((a, b) => b.runs - a.runs)

  // Simple regression detector — rolling window vs lifetime.
  const recentRegressions: RolledUp['recentRegressions'] = []
  for (const [key, list] of groups) {
    const [repo = 'unknown', kind = 'unknown'] = key.split('|')
    if (list.length < 6) continue
    const ordered = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const recent = ordered.slice(-3)
    const baseline = ordered.slice(0, -3)
    for (const metric of ['score', 'avgScore', 'criticalCount', 'criticalFindings'] as const) {
      const r = recent.map((e) => e.metrics[metric]).filter(isNum)
      const b = baseline.map((e) => e.metrics[metric]).filter(isNum)
      if (r.length === 0 || b.length === 0) continue
      const rAvg = avg(r)
      const bAvg = avg(b)
      const sign = metric === 'score' || metric === 'avgScore' ? -1 : 1 // higher score = better; higher critical = worse
      const delta = sign * (rAvg - bAvg)
      if (delta > 0.5) {
        recentRegressions.push({
          repo,
          kind,
          timestamp: recent[recent.length - 1]!.timestamp,
          metric,
          delta: round(rAvg - bAvg, 2),
        })
      }
    }
  }

  return {
    byRepoKind,
    byEvolveOutcome,
    byPromptHash,
    recentRegressions,
    agentIntegrity: buildAgentIntegrity(envelopes),
    totals: {
      repos: new Set(envelopes.map((e) => e.source.repo)).size,
      totalEnvelopes: envelopes.length,
      distinctRuns: new Set(envelopes.map((e) => e.runId)).size,
      distinctRepos: [...new Set(envelopes.map((e) => e.source.repo))].sort(),
    },
  }
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function buildAgentIntegrity(envelopes: TelemetryEnvelope[]): RolledUp['agentIntegrity'] {
  const byRun = new Map<string, TelemetryEnvelope[]>()
  for (const env of envelopes) {
    if (env.kind !== 'agent-run' && env.kind !== 'agent-step') continue
    const key = `${env.source.repo}\u0000${env.runId}`
    const list = byRun.get(key) ?? []
    list.push(env)
    byRun.set(key, list)
  }

  const findings: RolledUp['agentIntegrity'] = []
  for (const [, list] of byRun) {
    const runSummary = list.find((env) => env.kind === 'agent-run')
    const steps = list.filter((env) => env.kind === 'agent-step')
    const runId = list[0]?.runId ?? 'unknown'
    const issueCodes: string[] = []
    const eventTypes = new Set(steps.map(eventTypeOf).filter((eventType): eventType is string => Boolean(eventType)))
    const modelCallCount = metricNumber(runSummary, 'modelCallCount')
      ?? steps.filter((env) => hasModelUsage(env)).length
    const inputTokens = metricNumber(runSummary, 'inputTokens')
      ?? sumMetrics(steps, 'inputTokens')
    const outputTokens = metricNumber(runSummary, 'outputTokens')
      ?? sumMetrics(steps, 'outputTokens')

    if (!runSummary && steps.length > 0) issueCodes.push('missing_run_summary')
    if (runSummary && steps.length === 0) issueCodes.push('missing_steps')
    if (steps.length > 0 && !eventTypes.has('run-started')) issueCodes.push('missing_run_started')
    if (steps.length > 0 && !eventTypes.has('run-completed')) issueCodes.push('missing_run_completed')
    if (runSummary && modelCallCount === 0 && inputTokens === 0 && outputTokens === 0) {
      issueCodes.push('no_model_usage')
    }
    if (runSummary && !runSummary.ok && !runSummary.error && typeof runSummary.data.reason !== 'string') {
      issueCodes.push('missing_failure_reason')
    }

    if (issueCodes.length === 0) continue
    findings.push({
      repo: list[0]?.source.repo ?? 'unknown',
      runId,
      issueCodes,
      stepCount: steps.length,
      hasRunSummary: Boolean(runSummary),
      modelCallCount,
      inputTokens,
      outputTokens,
    })
  }

  findings.sort((a, b) => (a.repo + a.runId).localeCompare(b.repo + b.runId))
  return findings
}

function eventTypeOf(env: TelemetryEnvelope): string | undefined {
  const fromTags = env.tags?.eventType
  if (typeof fromTags === 'string') return fromTags
  const fromData = env.data.eventType
  return typeof fromData === 'string' ? fromData : undefined
}

function hasModelUsage(env: TelemetryEnvelope): boolean {
  return sumMetrics([env], 'inputTokens') > 0
    || sumMetrics([env], 'outputTokens') > 0
    || sumMetrics([env], 'cacheReadInputTokens') > 0
    || sumMetrics([env], 'cacheCreationInputTokens') > 0
}

function metricNumber(env: TelemetryEnvelope | undefined, metric: string): number | undefined {
  const value = env?.metrics[metric]
  return isNum(value) ? value : undefined
}

function sumMetrics(envelopes: TelemetryEnvelope[], metric: string): number {
  return envelopes.reduce((sum, env) => {
    const value = env.metrics[metric]
    return sum + (isNum(value) ? value : 0)
  }, 0)
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}
function avgMetric(envelopes: TelemetryEnvelope[], metric: string, digits: number): number | null {
  const values = envelopes.map((e) => e.metrics[metric]).filter(isNum)
  if (values.length === 0) return null
  if (digits === 0) return Math.round(avg(values))
  return round(avg(values), digits)
}
function round(v: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function printSummary(summary: RolledUp, totalEnvelopes: number, args: CliArgs): void {
  const filterLine = [
    args.repo ? `repo=${args.repo}` : null,
    args.kind ? `kind=${args.kind}` : null,
    args.since ? `since=${args.since}` : null,
    args.until ? `until=${args.until}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  console.log(`bad telemetry rollup · ${args.baseDir}${filterLine ? ` · ${filterLine}` : ''}`)
  console.log(`  envelopes: ${totalEnvelopes} · runs: ${summary.totals.distinctRuns} · repos: ${summary.totals.repos}`)
  console.log()

  console.log('Per repo × kind:')
  console.log('  repo                          kind                       runs  ok%   dur(ms)  score  finds  crit  tokens')
  for (const row of summary.byRepoKind) {
    console.log(
      `  ${pad(row.repo, 30)}${pad(row.kind, 25)}${pad(String(row.runs), 6)}${pad((row.okRate * 100).toFixed(0) + '%', 6)}${pad(String(Math.round(row.avgDurationMs)), 9)}${pad(row.avgScore?.toString() ?? '–', 7)}${pad(row.avgFindings?.toString() ?? '–', 7)}${pad(row.avgCritical?.toString() ?? '–', 6)}${pad(row.avgTokens?.toString() ?? '–', 8)}`,
    )
  }
  console.log()

  const agentRows = summary.byRepoKind.filter((row) => row.kind === 'agent-run')
  if (agentRows.length > 0) {
    console.log()
    console.log('Agent optimization:')
    console.log('  repo                          runs  ok%   cost/run  inTok  outTok  model  tools  fail  reject  skips')
    for (const row of agentRows) {
      console.log(
        `  ${pad(row.repo, 30)}${pad(String(row.runs), 6)}${pad((row.okRate * 100).toFixed(0) + '%', 6)}`
        + `${pad(row.avgEstimatedCostUsd == null ? '-' : row.avgEstimatedCostUsd.toFixed(6), 10)}`
        + `${pad(row.avgInputTokens?.toString() ?? '-', 7)}${pad(row.avgOutputTokens?.toString() ?? '-', 8)}`
        + `${pad(row.avgModelCalls?.toString() ?? '-', 7)}${pad(row.avgToolCalls?.toString() ?? '-', 7)}`
        + `${pad(row.avgExecuteFailures?.toString() ?? '-', 6)}${pad(row.avgVerificationRejections?.toString() ?? '-', 8)}`
        + `${pad(row.avgDecisionSkips?.toString() ?? '-', 6)}`,
      )
    }
  }

  const integrityRows = summary.agentIntegrity ?? []
  if (integrityRows.length > 0) {
    console.log()
    console.log('Agent telemetry integrity:')
    console.log('  repo                          runId                         steps  model  tokens  issues')
    for (const row of integrityRows.slice(0, 20)) {
      console.log(
        `  ${pad(row.repo, 30)}${pad(row.runId, 30)}${pad(String(row.stepCount), 7)}`
        + `${pad(String(row.modelCallCount), 7)}${pad(String(row.inputTokens + row.outputTokens), 8)}`
        + row.issueCodes.join(','),
      )
    }
  }

  if (summary.byEvolveOutcome.length > 0) {
    console.log('Evolve outcomes:')
    console.log('  repo                          runs  initial  final  Δ      converged%')
    for (const row of summary.byEvolveOutcome) {
      console.log(
        `  ${pad(row.repo, 30)}${pad(String(row.runs), 6)}${pad(row.avgInitialScore.toFixed(2), 9)}${pad(row.avgFinalScore.toFixed(2), 7)}${pad(row.avgDelta.toFixed(2), 7)}${pad((row.convergedRate * 100).toFixed(0) + '%', 11)}`,
      )
    }
    console.log()
  }

  if (summary.byPromptHash.length > 0) {
    console.log('Per prompt/rubric hash (≥2 runs):')
    console.log('  hash          runs  avgScore  avgFindings')
    for (const row of summary.byPromptHash.slice(0, 10)) {
      console.log(`  ${pad(row.promptHash, 14)}${pad(String(row.runs), 6)}${pad(row.avgScore.toFixed(2), 10)}${pad(row.avgFindings.toFixed(1), 13)}`)
    }
    console.log()
  }

  if (summary.recentRegressions.length > 0) {
    console.log('⚠ Possible regressions (recent 3 envelopes vs lifetime baseline):')
    for (const r of summary.recentRegressions) {
      console.log(`  ${r.repo} · ${r.kind} · ${r.metric} Δ ${r.delta} (latest ${r.timestamp})`)
    }
    console.log()
  }
}

function failOnAgentIntegrity(summary: { agentIntegrity?: AgentIntegrityFinding[] }, args: CliArgs): void {
  if (!args.failOnAgentIntegrity) return
  if (!Array.isArray(summary.agentIntegrity)) {
    console.error('[rollup] --fail-on-agent-integrity requires agentIntegrity in the rollup summary.')
    process.exit(1)
  }
  if (summary.agentIntegrity.length === 0) return

  console.error(`[rollup] agent telemetry integrity failed for ${summary.agentIntegrity.length} run(s):`)
  for (const row of summary.agentIntegrity.slice(0, 20)) {
    console.error(`  ${row.repo} ${row.runId}: ${row.issueCodes.join(',')}`)
  }
  process.exit(1)
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s
  return s + ' '.repeat(width - s.length)
}

// Exported so the test suite can drive the remote URL builder directly.
export { aggregate, buildRemoteUrl }

// Auto-run unless explicitly imported as a module by the test harness.
if (!process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN) {
  main().catch((err) => {
    console.error('[rollup]', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
