import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  recordRunsToScorecard,
  validateRunRecord,
  type RunRecord,
  type RunSplitTag,
} from '@tangle-network/agent-eval'
import { runPromotionGate } from '../bench/agent-eval/promotion-gate.js'
import type { TelemetryEnvelope } from '../src/telemetry/index.js'

const COMMIT_SHA = 'c'.repeat(40)
const PROMPT_HASH = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)
const MODEL_SNAPSHOT = 'gpt-5.4@2026-06-01'
const GATE_PATH = path.resolve(__dirname, '..', 'bench', 'agent-eval', 'promotion-gate.ts')

type RecordRunsOptions = Parameters<typeof recordRunsToScorecard>[2]

const SCORECARD_PROFILE = {
  name: 'bad-browser-agent',
  version: '0.34.0',
  model: { default: MODEL_SNAPSHOT },
  prompt: { hash: PROMPT_HASH },
  tools: { browser: true, bash: true, playwright: true },
  harness: { id: 'browser-agent-driver' },
} as RecordRunsOptions['profile']

describe('agent-eval promotion gate', () => {
  it('passes with real records, clean telemetry, scorecard evidence, and heldout promotion', async () => {
    const dir = tempDir('bad-promotion-pass-')
    const records = pairedRecords({
      candidateHoldout: [0.72, 0.75, 0.78],
      baselineHoldout: [0.42, 0.45, 0.48],
      candidateSearch: [0.72, 0.75, 0.78],
      baselineSearch: [0.42, 0.45, 0.48],
    })
    const recordsPath = writeRecords(dir, records)
    const scorecardPath = writeScorecard(dir, records)
    const telemetryDir = writeTelemetry(dir, [
      agentStep('clean', 'run-started'),
      agentStep('clean', 'decide-completed', { inputTokens: 100, outputTokens: 25 }),
      agentStep('clean', 'run-completed'),
      agentRun('clean', {
        inputTokens: 100,
        outputTokens: 25,
        estimatedCostUsd: 0.00008,
        modelCallCount: 1,
        toolCallCount: 2,
      }),
    ])

    const report = await runPromotionGate({
      recordsPath,
      scorecardPath,
      telemetryDir,
      candidateId: 'candidate',
      baselineCandidateId: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0.05,
      seed: 7,
    })

    expect(report.status).toBe('pass')
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ['backend-integrity', 'pass'],
      ['telemetry-integrity', 'pass'],
      ['scorecard-diff', 'pass'],
      ['heldout-gate', 'pass'],
    ])
    expect(report.heldoutDecision).toMatchObject({ promote: true })
  })

  it('fails backend integrity for all-zero-token records', async () => {
    const dir = tempDir('bad-promotion-backend-')
    const recordsPath = writeRecords(dir, [
      runRecord({ candidateId: 'candidate', seed: 1, score: 0, inputTokens: 0, outputTokens: 0 }),
    ])

    const report = await runPromotionGate({ recordsPath })

    expect(report.status).toBe('fail')
    expect(report.checks.find((check) => check.name === 'backend-integrity')).toMatchObject({
      status: 'fail',
    })
  })

  it('fails telemetry integrity when agent-run summaries have no steps or model usage', async () => {
    const dir = tempDir('bad-promotion-telemetry-')
    const recordsPath = writeRecords(dir, [runRecord({ candidateId: 'candidate', seed: 1, score: 1 })])
    const telemetryDir = writeTelemetry(dir, [
      agentRun('broken', {
        inputTokens: 0,
        outputTokens: 0,
        modelCallCount: 0,
      }),
    ])

    const report = await runPromotionGate({ recordsPath, telemetryDir })

    expect(report.status).toBe('fail')
    expect(report.checks.find((check) => check.name === 'telemetry-integrity')).toMatchObject({
      status: 'fail',
    })
    expect(report.telemetryIntegrity).toEqual([
      expect.objectContaining({
        runId: 'broken',
        issueCodes: expect.arrayContaining(['missing_steps', 'no_model_usage']),
      }),
    ])
  })

  it('fails scorecard diff on validated regressions', async () => {
    const dir = tempDir('bad-promotion-scorecard-')
    const prior = [0.80, 0.86, 0.92].map((score, index) =>
      runRecord({ candidateId: 'candidate', seed: index + 1, scenarioId: 'stable-scenario', score }),
    )
    const latest = [0.20, 0.26, 0.32].map((score, index) =>
      runRecord({
        candidateId: 'candidate',
        seed: index + 1,
        scenarioId: 'stable-scenario',
        score,
        commitSha: 'd'.repeat(40),
      }),
    )
    const recordsPath = writeRecords(dir, latest)
    const scorecardPath = path.join(dir, 'scorecard.jsonl')
    recordRunsToScorecard(scorecardPath, prior, {
      profile: SCORECARD_PROFILE,
      commitSha: COMMIT_SHA,
      timestamp: '2026-06-26T12:00:00.000Z',
    })
    recordRunsToScorecard(scorecardPath, latest, {
      profile: SCORECARD_PROFILE,
      commitSha: 'd'.repeat(40),
      timestamp: '2026-06-26T12:01:00.000Z',
    })

    const report = await runPromotionGate({ recordsPath, scorecardPath })

    expect(report.status).toBe('fail')
    expect(report.checks.find((check) => check.name === 'scorecard-diff')).toMatchObject({
      status: 'fail',
    })
    expect(report.scorecardDiff?.summary.regressed).toBeGreaterThan(0)
  })

  it('fails heldout gate when required evidence has too few productive pairs', async () => {
    const dir = tempDir('bad-promotion-heldout-')
    const recordsPath = writeRecords(dir, pairedRecords({
      candidateHoldout: [0.9],
      baselineHoldout: [0.5],
      candidateSearch: [0.9],
      baselineSearch: [0.5],
    }))

    const report = await runPromotionGate({
      recordsPath,
      candidateId: 'candidate',
      baselineCandidateId: 'baseline',
      requireHeldout: true,
      minProductiveRuns: 3,
    })

    expect(report.status).toBe('fail')
    expect(report.heldoutDecision).toMatchObject({
      promote: false,
      rejectionCode: 'few_runs',
    })
  })

  it('fails heldout gate on negative paired deltas', async () => {
    const dir = tempDir('bad-promotion-heldout-negative-')
    const recordsPath = writeRecords(dir, pairedRecords({
      candidateHoldout: [0.30, 0.34, 0.38],
      baselineHoldout: [0.50, 0.54, 0.58],
      candidateSearch: [0.30, 0.34, 0.38],
      baselineSearch: [0.50, 0.54, 0.58],
    }))

    const report = await runPromotionGate({
      recordsPath,
      candidateId: 'candidate',
      baselineCandidateId: 'baseline',
      requireHeldout: true,
      minProductiveRuns: 3,
    })

    expect(report.status).toBe('fail')
    expect(report.heldoutDecision).toMatchObject({
      promote: false,
      rejectionCode: 'negative_delta',
    })
  })

  it('runs from the CLI and emits JSON', () => {
    const dir = tempDir('bad-promotion-cli-')
    const recordsPath = writeRecords(dir, [runRecord({ candidateId: 'candidate', seed: 1, score: 1 })])
    const out = spawnSync('pnpm', ['exec', 'tsx', GATE_PATH, '--records', recordsPath, '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, BAD_TELEMETRY_ROLLUP_NO_AUTORUN: '1' },
    })

    expect(out.status).toBe(0)
    expect(JSON.parse(out.stdout)).toMatchObject({
      status: 'pass',
      runRecordCount: 1,
    })
  })
})

function pairedRecords(args: {
  candidateHoldout: number[]
  baselineHoldout: number[]
  candidateSearch: number[]
  baselineSearch: number[]
}): RunRecord[] {
  return [
    ...args.baselineHoldout.map((score, index) => runRecord({
      candidateId: 'baseline',
      seed: index + 1,
      splitTag: 'holdout',
      score,
    })),
    ...args.candidateHoldout.map((score, index) => runRecord({
      candidateId: 'candidate',
      seed: index + 1,
      splitTag: 'holdout',
      score,
    })),
    ...args.baselineSearch.map((score, index) => runRecord({
      candidateId: 'baseline',
      seed: index + 1,
      splitTag: 'search',
      score,
    })),
    ...args.candidateSearch.map((score, index) => runRecord({
      candidateId: 'candidate',
      seed: index + 1,
      splitTag: 'search',
      score,
    })),
  ]
}

function runRecord(args: {
  candidateId: string
  seed: number
  score: number
  splitTag?: RunSplitTag
  scenarioId?: string
  inputTokens?: number
  outputTokens?: number
  commitSha?: string
}): RunRecord {
  const splitTag = args.splitTag ?? 'holdout'
  const scoreKey = splitTag === 'holdout' ? 'holdoutScore' : 'searchScore'
  const scenarioId = args.scenarioId ?? `scenario-${args.seed}`
  return validateRunRecord({
    runId: `${args.candidateId}-${splitTag}-${args.seed}-${args.commitSha ?? COMMIT_SHA}`,
    experimentId: 'exp-promotion-gate',
    candidateId: args.candidateId,
    seed: args.seed,
    model: MODEL_SNAPSHOT,
    promptHash: PROMPT_HASH,
    configHash: CONFIG_HASH,
    commitSha: args.commitSha ?? COMMIT_SHA,
    wallMs: 1000 + args.seed,
    costUsd: 0.001,
    tokenUsage: {
      input: args.inputTokens ?? 100,
      output: args.outputTokens ?? 20,
      cached: 0,
    },
    outcome: {
      [scoreKey]: args.score,
      raw: {
        score: args.score,
        seed: args.seed,
      },
    },
    splitTag,
    scenarioId,
  })
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeRecords(dir: string, records: RunRecord[]): string {
  const recordsPath = path.join(dir, 'records.jsonl')
  fs.writeFileSync(recordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return recordsPath
}

function writeScorecard(dir: string, records: RunRecord[]): string {
  const scorecardPath = path.join(dir, 'scorecard.jsonl')
  recordRunsToScorecard(scorecardPath, records, {
    profile: SCORECARD_PROFILE,
    commitSha: COMMIT_SHA,
    timestamp: '2026-06-26T12:00:00.000Z',
  })
  return scorecardPath
}

function writeTelemetry(dir: string, envelopes: TelemetryEnvelope[]): string {
  const telemetryDir = path.join(dir, 'telemetry', 'browser-agent-driver')
  fs.mkdirSync(telemetryDir, { recursive: true })
  fs.writeFileSync(
    path.join(telemetryDir, '2026-06-26.jsonl'),
    `${envelopes.map((env) => JSON.stringify(env)).join('\n')}\n`,
  )
  return path.join(dir, 'telemetry')
}

function agentRun(runId: string, metrics: Record<string, number>, ok = true): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: `${runId}-summary`,
    runId,
    timestamp: '2026-06-26T12:00:00.000Z',
    source: source(),
    kind: 'agent-run',
    ok,
    durationMs: 1000,
    data: {},
    metrics,
  }
}

function agentStep(runId: string, eventType: string, metrics: Record<string, number> = {}): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: `${runId}-${eventType}`,
    runId,
    timestamp: '2026-06-26T12:00:00.000Z',
    source: source(),
    kind: 'agent-step',
    ok: true,
    durationMs: 1,
    data: { eventType },
    metrics,
    tags: { eventType },
  }
}

function source(): TelemetryEnvelope['source'] {
  return {
    repo: 'browser-agent-driver',
    cwd: '/repo',
    cliVersion: 'test',
    invocation: 'bad run',
  }
}
