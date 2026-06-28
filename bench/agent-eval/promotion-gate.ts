#!/usr/bin/env npx tsx

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  HeldOutGate,
  assertRealBackend,
  diffScorecard,
  formatScorecardDiff,
  loadScorecard,
  summarizeBackendIntegrity,
  validateRunRecord,
  type BackendIntegrityReport,
  type RunRecord,
  type ScorecardDiff,
} from '@tangle-network/agent-eval'
import type { TelemetryEnvelope } from '../../src/telemetry/schema.js'

export type PromotionGateStatus = 'pass' | 'fail'

export interface PromotionGateCheck {
  name: string
  status: PromotionGateStatus
  summary: string
  details?: unknown
}

export interface PromotionGateOptions {
  recordsPath?: string
  scorecardPath?: string
  telemetryDir?: string
  candidateId?: string
  baselineCandidateId?: string
  requireHeldout?: boolean
  allowMixedBackend?: boolean
  allowScorecardRegressions?: boolean
  minProductiveRuns?: number
  pairedDeltaThreshold?: number
  overfitGapThreshold?: number
  costPerTaskCeiling?: number
  seed?: number
}

export interface PromotionGateReport {
  status: PromotionGateStatus
  generatedAt: string
  recordsPath?: string
  scorecardPath?: string
  telemetryDir?: string
  runRecordCount: number
  checks: PromotionGateCheck[]
  backendIntegrity?: BackendIntegrityReport
  scorecardDiff?: ScorecardDiff
  scorecardDiffText?: string
  heldoutDecision?: unknown
  telemetryIntegrity?: unknown[]
}

export async function runPromotionGate(options: PromotionGateOptions): Promise<PromotionGateReport> {
  const records = loadRunRecords(requirePath('recordsPath', options.recordsPath))
  const checks: PromotionGateCheck[] = []

  const backend = checkBackendIntegrity(records, options)
  checks.push(backend.check)

  let telemetryIntegrity: unknown[] | undefined
  if (options.telemetryDir) {
    const telemetry = await checkTelemetryIntegrity(options.telemetryDir)
    telemetryIntegrity = telemetry.findings
    checks.push(telemetry.check)
  }

  let scorecardDiff: ScorecardDiff | undefined
  let scorecardDiffText: string | undefined
  if (options.scorecardPath) {
    const scorecard = loadScorecard(options.scorecardPath)
    scorecardDiff = diffScorecard(scorecard)
    scorecardDiffText = formatScorecardDiff(scorecardDiff)
    checks.push(checkScorecardDiff(scorecardDiff, options))
  }

  let heldoutDecision: unknown
  if (options.candidateId || options.requireHeldout) {
    const heldout = checkHeldout(records, options)
    heldoutDecision = heldout.decision
    checks.push(heldout.check)
  }

  return {
    status: checks.some((check) => check.status === 'fail') ? 'fail' : 'pass',
    generatedAt: new Date().toISOString(),
    ...(options.recordsPath ? { recordsPath: path.resolve(options.recordsPath) } : {}),
    ...(options.scorecardPath ? { scorecardPath: path.resolve(options.scorecardPath) } : {}),
    ...(options.telemetryDir ? { telemetryDir: path.resolve(options.telemetryDir) } : {}),
    runRecordCount: records.length,
    checks,
    backendIntegrity: backend.report,
    ...(scorecardDiff ? { scorecardDiff } : {}),
    ...(scorecardDiffText ? { scorecardDiffText } : {}),
    ...(heldoutDecision ? { heldoutDecision } : {}),
    ...(telemetryIntegrity ? { telemetryIntegrity } : {}),
  }
}

function loadRunRecords(recordsPath: string): RunRecord[] {
  if (!fs.existsSync(recordsPath)) {
    throw new Error(`RunRecord file not found: ${recordsPath}`)
  }
  const records = readJsonl(recordsPath).map((value, index) => {
    try {
      return validateRunRecord(value)
    } catch (error) {
      throw new Error(`Invalid RunRecord at ${recordsPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (records.length === 0) {
    throw new Error(`RunRecord file produced zero records: ${recordsPath}`)
  }
  return records
}

function checkBackendIntegrity(records: RunRecord[], options: PromotionGateOptions): {
  check: PromotionGateCheck
  report: BackendIntegrityReport
} {
  const report = summarizeBackendIntegrity(records)
  try {
    assertRealBackend(records, { allowMixed: options.allowMixedBackend === true })
    return {
      report,
      check: {
        name: 'backend-integrity',
        status: 'pass',
        summary: report.diagnosis,
        details: report,
      },
    }
  } catch (error) {
    return {
      report,
      check: {
        name: 'backend-integrity',
        status: 'fail',
        summary: error instanceof Error ? error.message : report.diagnosis,
        details: report,
      },
    }
  }
}

async function checkTelemetryIntegrity(telemetryDir: string): Promise<{
  check: PromotionGateCheck
  findings: unknown[]
}> {
  const envelopes = readTelemetryEnvelopes(telemetryDir)
  if (envelopes.length === 0) {
    return {
      findings: [],
      check: {
        name: 'telemetry-integrity',
        status: 'fail',
        summary: `telemetry directory produced zero envelopes: ${telemetryDir}`,
      },
    }
  }

  const aggregate = await loadTelemetryAggregate()
  const summary = aggregate(envelopes) as { agentIntegrity?: unknown[] }
  const findings = Array.isArray(summary.agentIntegrity) ? summary.agentIntegrity : []
  return {
    findings,
    check: {
      name: 'telemetry-integrity',
      status: findings.length === 0 ? 'pass' : 'fail',
      summary: findings.length === 0
        ? `telemetry integrity passed for ${envelopes.length} envelope(s)`
        : `telemetry integrity failed for ${findings.length} run(s)`,
      details: findings,
    },
  }
}

function checkScorecardDiff(diff: ScorecardDiff, options: PromotionGateOptions): PromotionGateCheck {
  const regressions = diff.summary.regressed
  const status = regressions > 0 && options.allowScorecardRegressions !== true ? 'fail' : 'pass'
  return {
    name: 'scorecard-diff',
    status,
    summary: status === 'pass'
      ? `scorecard diff passed: ${diff.summary.improved} improved, ${diff.summary.regressed} regressed, ${diff.summary.flat} flat, ${diff.summary.new} new`
      : `scorecard diff failed: ${diff.summary.regressed} regressed cell(s)`,
    details: diff.summary,
  }
}

function checkHeldout(records: RunRecord[], options: PromotionGateOptions): {
  check: PromotionGateCheck
  decision?: unknown
} {
  const candidateId = options.candidateId
  const baselineId = options.baselineCandidateId ?? 'baseline'
  if (!candidateId) {
    return {
      check: {
        name: 'heldout-gate',
        status: 'fail',
        summary: '--candidate-id is required when --require-heldout is enabled',
      },
    }
  }

  const candidate = records.filter((record) => record.candidateId === candidateId)
  const baseline = records.filter((record) => record.candidateId === baselineId)
  if (candidate.length === 0 || baseline.length === 0) {
    return {
      check: {
        name: 'heldout-gate',
        status: 'fail',
        summary: `heldout gate missing records for candidate="${candidateId}" or baseline="${baselineId}"`,
        details: { candidateRecords: candidate.length, baselineRecords: baseline.length },
      },
    }
  }

  const gate = new HeldOutGate({
    baselineKey: baselineId,
    minProductiveRuns: options.minProductiveRuns ?? 3,
    pairedDeltaThreshold: options.pairedDeltaThreshold ?? 0,
    overfitGapThreshold: options.overfitGapThreshold ?? 0.15,
    ...(options.costPerTaskCeiling !== undefined ? { costPerTaskCeiling: options.costPerTaskCeiling } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  })
  const decision = gate.evaluate(candidate, baseline) as { promote?: boolean; reason?: string; rejectionCode?: string | null }
  return {
    decision,
    check: {
      name: 'heldout-gate',
      status: decision.promote === true ? 'pass' : 'fail',
      summary: decision.reason ?? (decision.promote === true ? 'heldout gate passed' : 'heldout gate failed'),
      details: decision,
    },
  }
}

async function loadTelemetryAggregate(): Promise<(envelopes: TelemetryEnvelope[]) => unknown> {
  const previous = process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
  process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN = '1'
  const mod = await import('../telemetry/rollup.js')
  if (previous === undefined) delete process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
  else process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN = previous
  if (typeof mod.aggregate !== 'function') {
    throw new Error('telemetry rollup aggregate() export is unavailable')
  }
  return mod.aggregate as (envelopes: TelemetryEnvelope[]) => unknown
}

function readTelemetryEnvelopes(root: string): TelemetryEnvelope[] {
  if (!fs.existsSync(root)) {
    throw new Error(`telemetry directory not found: ${root}`)
  }
  return listJsonlFiles(root).flatMap((filePath) =>
    readJsonl(filePath).map((value) => value as TelemetryEnvelope),
  )
}

function readJsonl(filePath: string): unknown[] {
  const values: unknown[] = []
  const text = fs.readFileSync(filePath, 'utf-8')
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      values.push(JSON.parse(trimmed))
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return values
}

function listJsonlFiles(root: string): string[] {
  const files: string[] = []
  const stack = [path.resolve(root)]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  return files.sort()
}

function requirePath(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`)
  return path.resolve(value)
}

function formatReport(report: PromotionGateReport): string {
  const lines = [
    `Agent-eval promotion gate: ${report.status.toUpperCase()}`,
    `RunRecords: ${report.runRecordCount}`,
  ]
  for (const check of report.checks) {
    lines.push(`- ${check.name}: ${check.status.toUpperCase()} — ${check.summary}`)
  }
  if (report.scorecardDiffText) {
    lines.push('', report.scorecardDiffText.trim())
  }
  return lines.join('\n')
}

function parseNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be numeric`)
  return parsed
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      records: { type: 'string' },
      scorecard: { type: 'string' },
      'telemetry-dir': { type: 'string' },
      'candidate-id': { type: 'string' },
      'baseline-candidate-id': { type: 'string' },
      'require-heldout': { type: 'boolean' },
      'allow-mixed-backend': { type: 'boolean' },
      'allow-scorecard-regressions': { type: 'boolean' },
      'min-productive-runs': { type: 'string' },
      'paired-delta-threshold': { type: 'string' },
      'overfit-gap-threshold': { type: 'string' },
      'cost-per-task-ceiling': { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const report = await runPromotionGate({
    recordsPath: values.records,
    scorecardPath: values.scorecard,
    telemetryDir: values['telemetry-dir'],
    candidateId: values['candidate-id'],
    baselineCandidateId: values['baseline-candidate-id'],
    requireHeldout: values['require-heldout'] === true,
    allowMixedBackend: values['allow-mixed-backend'] === true,
    allowScorecardRegressions: values['allow-scorecard-regressions'] === true,
    minProductiveRuns: parseNumber('min-productive-runs', values['min-productive-runs']),
    pairedDeltaThreshold: parseNumber('paired-delta-threshold', values['paired-delta-threshold']),
    overfitGapThreshold: parseNumber('overfit-gap-threshold', values['overfit-gap-threshold']),
    costPerTaskCeiling: parseNumber('cost-per-task-ceiling', values['cost-per-task-ceiling']),
    seed: parseNumber('seed', values.seed),
  })

  if (values.out) {
    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
    fs.writeFileSync(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`)
  }

  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report))
  process.exit(report.status === 'pass' ? 0 : 1)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
