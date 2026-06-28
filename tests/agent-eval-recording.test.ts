import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { diffScorecard, loadScorecard, validateRunRecord } from '@tangle-network/agent-eval'

const COMMIT_SHA = 'c'.repeat(40)
const PROMPT_HASH = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)
const MODEL_SNAPSHOT = 'gpt-5.4@2026-06-01'

describe('benchmark agent-eval recorder', () => {
  it('writes validated RunRecords and appends scorecard lines from a track summary', async () => {
    const { recordTrackSummaryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-records-'))
    const recordsPath = path.join(dir, 'records.jsonl')
    const scorecardPath = path.join(dir, 'scorecard.jsonl')

    const result = await recordTrackSummaryAgentEval(trackSummary(), {
      recordsPath,
      scorecardPath,
      experimentId: 'exp-webvoyager-smoke',
      candidateId: 'baseline',
      seed: 7,
      splitTag: 'search',
      modelSnapshot: MODEL_SNAPSHOT,
      configHash: CONFIG_HASH,
      profileName: 'bad-browser-agent',
      profileVersion: '0.34.0',
    })

    expect(result.records).toHaveLength(2)
    expect(result.rejected).toEqual([])
    expect(result.scorecardLines).toHaveLength(1)
    expect(result.records[0].agentProfile.cellId).toMatch(/^agent-profile-cell:sha256:/)

    const records = fs.readFileSync(recordsPath, 'utf-8').trim().split('\n').map((line) => validateRunRecord(JSON.parse(line)))
    expect(records).toHaveLength(2)
    expect(records[0].scenarioId).toBe('checkout-flow')
    expect(records[0].outcome.searchScore).toBe(1)
    expect(records[1].failureMode).toBe('verification_failed')

    const scorecard = loadScorecard(scorecardPath)
    expect(scorecard.cells).toHaveLength(1)
    expect(scorecard.cells[0]?.scenarioId).toBe('checkout-flow')
    expect(scorecard.cells[0]?.timeline[0]?.runIds).toEqual(records.map((record) => record.runId))
  })

  it('requires pinned model snapshots before producing records', async () => {
    const { trackSummaryToRunRecords } = await loadHelper()

    await expect(
      trackSummaryToRunRecords(trackSummary(), {
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        splitTag: 'search',
        modelSnapshot: 'gpt-5.4',
        configHash: CONFIG_HASH,
      }),
    ).rejects.toThrow('modelSnapshot must include')
  })

  it('fails closed when a benchmark run has no model token usage', async () => {
    const { recordTrackSummaryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-zero-'))

    await expect(
      recordTrackSummaryAgentEval(trackSummary({ inputTokens: 0, outputTokens: 0 }), {
        recordsPath: path.join(dir, 'records.jsonl'),
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        splitTag: 'search',
        modelSnapshot: MODEL_SNAPSHOT,
        configHash: CONFIG_HASH,
      }),
    ).rejects.toThrow('benchmark run has no model token usage')
  })

  it('maps holdout failures to holdoutScore and preserves failure detail', async () => {
    const { trackSummaryToRunRecords } = await loadHelper()

    const { records } = await trackSummaryToRunRecords(
      trackSummary({
        passed: false,
        agentSuccess: false,
        exitCode: 1,
        verdict: 'planner_parse_failed',
      }, { singleRun: true }),
      {
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        splitTag: 'holdout',
        modelSnapshot: MODEL_SNAPSHOT,
        configHash: CONFIG_HASH,
      },
    )

    expect(records).toHaveLength(1)
    expect(records[0].outcome.holdoutScore).toBe(0)
    expect(records[0].outcome.searchScore).toBeUndefined()
    expect(records[0].failureMode).toBe('planner_parse_failed')
  })

  it('accepts dev split records as search-score evidence', async () => {
    const { trackSummaryToRunRecords } = await loadHelper()

    const { records } = await trackSummaryToRunRecords(trackSummary({}, { singleRun: true }), {
      experimentId: 'exp',
      candidateId: 'candidate',
      seed: 1,
      splitTag: 'dev',
      modelSnapshot: MODEL_SNAPSHOT,
      configHash: CONFIG_HASH,
    })

    expect(records[0].splitTag).toBe('dev')
    expect(records[0].outcome.searchScore).toBe(1)
    expect(records[0].outcome.holdoutScore).toBeUndefined()
  })

  it('records from real agent-run telemetry envelopes', async () => {
    const { recordTelemetryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-telemetry-'))
    const telemetryDir = path.join(dir, 'telemetry', 'browser-agent-driver')
    fs.mkdirSync(telemetryDir, { recursive: true })
    fs.writeFileSync(
      path.join(telemetryDir, '2026-06-26.jsonl'),
      `${JSON.stringify(agentRunEnvelope())}\n${JSON.stringify({ ...agentRunEnvelope(), kind: 'agent-step' })}\n`,
    )

    const result = await recordTelemetryAgentEval({
      telemetryDirs: [path.join(dir, 'telemetry')],
      recordsPath: path.join(dir, 'records.jsonl'),
      scorecardPath: path.join(dir, 'scorecard.jsonl'),
      experimentId: 'exp',
      candidateId: 'candidate',
      seed: 1,
      scenarioId: 'scenario',
      splitTag: 'search',
      modelSnapshot: MODEL_SNAPSHOT,
      promptHash: PROMPT_HASH,
      configHash: CONFIG_HASH,
      commitSha: COMMIT_SHA,
      profileName: 'bad-browser-agent',
      profileVersion: '0.34.0',
      benchmarkProfile: 'default',
      driverProfile: 'full-evidence',
      modes: ['full-evidence'],
    })

    expect(result.records).toHaveLength(1)
    expect(result.records[0].runId).toBe('telemetry-run-1')
    expect(result.records[0].tokenUsage).toEqual({ input: 120, output: 30, cached: 10 })
    expect(result.backendIntegrity.verdict).toBe('real')
    expect(fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1)
    expect(loadScorecard(path.join(dir, 'scorecard.jsonl')).cells).toHaveLength(1)
  })

  it('keeps run-mode-baseline production recording on telemetry envelopes', () => {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'run-mode-baseline.mjs'), 'utf-8')

    expect(source).toContain('recordTelemetryAgentEval')
    expect(source).toContain('telemetryDirs:')
    expect(source).not.toContain('recordTrackSummaryAgentEval')
  })

  it('does not write partial files when one summary run is rejected', async () => {
    const { recordTrackSummaryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-summary-reject-'))
    const recordsPath = path.join(dir, 'records.jsonl')
    const scorecardPath = path.join(dir, 'scorecard.jsonl')

    await expect(
      recordTrackSummaryAgentEval(trackSummary({ durationMs: -1 }), {
        ...summaryRecordingOptions(),
        recordsPath,
        scorecardPath,
      }),
    ).rejects.toThrow('wallMs must be non-negative')

    expect(fs.existsSync(recordsPath)).toBe(false)
    expect(fs.existsSync(scorecardPath)).toBe(false)
  })

  it('does not write partial files when one telemetry run is rejected', async () => {
    const { recordTelemetryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-telemetry-reject-'))
    const telemetryDir = writeTelemetry(dir, [
      agentRunEnvelope({ runId: 'telemetry-run-good' }),
      agentRunEnvelope({ runId: 'telemetry-run-bad', metrics: { estimatedCostUsd: -0.01 } }),
    ])
    const recordsPath = path.join(dir, 'records.jsonl')
    const scorecardPath = path.join(dir, 'scorecard.jsonl')

    await expect(
      recordTelemetryAgentEval({
        ...telemetryRecordingOptions(),
        telemetryDirs: [telemetryDir],
        recordsPath,
        scorecardPath,
      }),
    ).rejects.toThrow('costUsd must be non-negative')

    expect(fs.existsSync(recordsPath)).toBe(false)
    expect(fs.existsSync(scorecardPath)).toBe(false)
  })

  it('fails closed on empty summary and telemetry inputs without creating outputs', async () => {
    const { recordTelemetryAgentEval, recordTrackSummaryAgentEval } = await loadHelper()
    const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-empty-summary-'))
    const telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-empty-telemetry-'))
    const onlyStepsDir = writeTelemetry(telemetryDir, [{ ...agentRunEnvelope(), kind: 'agent-step' }])

    await expect(
      recordTrackSummaryAgentEval({ ...trackSummary(), results: [] }, {
        ...summaryRecordingOptions({ promptHash: PROMPT_HASH }),
        recordsPath: path.join(summaryDir, 'records.jsonl'),
      }),
    ).rejects.toThrow('agent-eval recording produced zero RunRecords')
    expect(fs.existsSync(path.join(summaryDir, 'records.jsonl'))).toBe(false)

    await expect(
      recordTelemetryAgentEval({
        ...telemetryRecordingOptions(),
        telemetryDirs: [onlyStepsDir],
        recordsPath: path.join(telemetryDir, 'records.jsonl'),
      }),
    ).rejects.toThrow('agent-eval recording found no agent-run telemetry records')
    expect(fs.existsSync(path.join(telemetryDir, 'records.jsonl'))).toBe(false)
  })

  it('rejects invalid telemetry metadata before writing evidence', async () => {
    const { recordTelemetryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-invalid-meta-'))
    const telemetryDir = writeTelemetry(dir, [agentRunEnvelope()])
    const invalidCases: Array<[string, Record<string, unknown>, string]> = [
      ['candidateId', { candidateId: '' }, 'candidateId is required'],
      ['scenarioId', { scenarioId: '' }, 'scenarioId is required'],
      ['seed', { seed: 'not-a-number' }, 'seed must be a finite number'],
      ['splitTag', { splitTag: 'train' }, 'splitTag must be one of'],
      ['promptHash', { promptHash: 'not-a-hash' }, 'promptHash must be a 64-character hex sha256'],
      ['configHash', { configHash: 'not-a-hash' }, 'configHash must be a 64-character hex sha256'],
      ['commitSha', { commitSha: 'abc123' }, 'commitSha must be a 40-character git SHA'],
    ]

    for (const [name, overrides, message] of invalidCases) {
      const recordsPath = path.join(dir, `${name}.jsonl`)
      await expect(
        recordTelemetryAgentEval({
          ...telemetryRecordingOptions(),
          ...overrides,
          telemetryDirs: [telemetryDir],
          recordsPath,
        }),
      ).rejects.toThrow(message)
      expect(fs.existsSync(recordsPath)).toBe(false)
    }
  })

  it('rejects corrupt numeric metrics instead of coercing them into zeroes', async () => {
    const { recordTelemetryAgentEval, recordTrackSummaryAgentEval } = await loadHelper()
    const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-numeric-summary-'))
    const telemetryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-numeric-telemetry-'))
    const corruptTelemetryDir = writeTelemetry(telemetryDir, [
      agentRunEnvelope({ metrics: { cacheReadInputTokens: 'not-a-number' } }),
    ])

    await expect(
      recordTrackSummaryAgentEval(trackSummary({ durationMs: 'not-a-number' }), {
        ...summaryRecordingOptions(),
        recordsPath: path.join(summaryDir, 'records.jsonl'),
      }),
    ).rejects.toThrow('durationMs must be numeric')

    await expect(
      recordTelemetryAgentEval({
        ...telemetryRecordingOptions(),
        telemetryDirs: [corruptTelemetryDir],
        recordsPath: path.join(telemetryDir, 'records.jsonl'),
      }),
    ).rejects.toThrow('cacheReadInputTokens must be numeric')
  })

  it('overwrites the records artifact but appends scorecard timeline entries', async () => {
    const { recordTrackSummaryAgentEval } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-scorecard-append-'))
    const recordsPath = path.join(dir, 'records.jsonl')
    const scorecardPath = path.join(dir, 'scorecard.jsonl')

    await recordTrackSummaryAgentEval(trackSummary({}, { singleRun: true }), {
      ...summaryRecordingOptions({ commitSha: COMMIT_SHA }),
      recordsPath,
      scorecardPath,
    })
    await recordTrackSummaryAgentEval(trackSummary({}, { singleRun: true }), {
      ...summaryRecordingOptions({ commitSha: 'd'.repeat(40), seed: 2 }),
      recordsPath,
      scorecardPath,
    })

    expect(fs.readFileSync(recordsPath, 'utf-8').trim().split('\n')).toHaveLength(1)
    const scorecard = loadScorecard(scorecardPath)
    expect(scorecard.cells).toHaveLength(1)
    expect(scorecard.cells[0]?.timeline).toHaveLength(2)
    expect(() => diffScorecard(scorecard)).not.toThrow()
  })

  it('rejects duplicate RunRecord ids while aggregating child JSONL', async () => {
    const { concatenateAgentEvalJsonl } = await loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-aggregate-'))
    const firstPath = path.join(dir, 'first.jsonl')
    const secondPath = path.join(dir, 'second.jsonl')
    const outputPath = path.join(dir, 'combined.jsonl')
    fs.writeFileSync(firstPath, `${JSON.stringify({ runId: 'duplicate-run', value: 1 })}\n`)
    fs.writeFileSync(secondPath, `${JSON.stringify({ runId: 'duplicate-run', value: 2 })}\n`)

    expect(() =>
      concatenateAgentEvalJsonl({
        inputPaths: [firstPath, secondPath],
        outputPath,
        label: 'agent-eval RunRecords',
        requireUniqueRunIds: true,
      }),
    ).toThrow('Duplicate RunRecord runId')
    expect(fs.existsSync(outputPath)).toBe(false)
  })
})

async function loadHelper() {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const helperPath = path.resolve(testDir, '..', 'scripts', 'lib', 'agent-eval-records.mjs')
  return import(pathToFileURL(helperPath).href)
}

function trackSummary(
  runOverrides: Record<string, unknown> = {},
  options: { singleRun?: boolean } = {},
) {
  const runs = options.singleRun
    ? [baselineRun('full-evidence', runOverrides)]
    : [baselineRun('full-evidence', runOverrides), baselineRun('fast-explore', { passed: false })]

  return {
    generatedAt: '2026-06-26T12:00:00.000Z',
    gitSha: COMMIT_SHA,
    benchmarkProfile: 'default',
    driverProfile: 'full-evidence',
    results: [
      {
        scenarioId: 'checkout-flow',
        scenarioName: 'Checkout flow',
        exitCode: 0,
        summary: {
          promptHash: PROMPT_HASH,
          runs,
        },
      },
    ],
  }
}

function baselineRun(mode: string, overrides: Record<string, unknown> = {}) {
  const passed = overrides.passed ?? true
  return {
    mode,
    startedAt: '2026-06-26T12:00:00.000Z',
    endedAt: '2026-06-26T12:00:03.000Z',
    exitCode: overrides.exitCode ?? 0,
    signal: null,
    reportPath: `/tmp/${mode}/report.json`,
    metrics: {
      passed,
      agentSuccess: overrides.agentSuccess ?? passed,
      durationMs: overrides.durationMs ?? 3000,
      turnsUsed: overrides.turnsUsed ?? 3,
      tokensUsed: overrides.tokensUsed ?? 150,
      inputTokens: overrides.inputTokens ?? 120,
      outputTokens: overrides.outputTokens ?? 30,
      estimatedCostUsd: overrides.estimatedCostUsd ?? 0.012,
      verdict: overrides.verdict ?? (passed ? 'pass' : 'verification_failed'),
    },
    memory: { enabled: false, isolation: 'shared', dir: null },
    artifactCheck: { passed: true },
  }
}

function summaryRecordingOptions(overrides: Record<string, unknown> = {}) {
  return {
    experimentId: 'exp',
    candidateId: 'candidate',
    seed: 1,
    splitTag: 'search',
    modelSnapshot: MODEL_SNAPSHOT,
    configHash: CONFIG_HASH,
    profileName: 'bad-browser-agent',
    profileVersion: '0.34.0',
    ...overrides,
  }
}

function telemetryRecordingOptions(overrides: Record<string, unknown> = {}) {
  return {
    experimentId: 'exp',
    candidateId: 'candidate',
    seed: 1,
    scenarioId: 'scenario',
    splitTag: 'search',
    modelSnapshot: MODEL_SNAPSHOT,
    promptHash: PROMPT_HASH,
    configHash: CONFIG_HASH,
    commitSha: COMMIT_SHA,
    profileName: 'bad-browser-agent',
    profileVersion: '0.34.0',
    benchmarkProfile: 'default',
    driverProfile: 'full-evidence',
    modes: ['full-evidence'],
    ...overrides,
  }
}

function writeTelemetry(dir: string, envelopes: Array<Record<string, unknown>>) {
  const telemetryDir = path.join(dir, 'telemetry', 'browser-agent-driver')
  fs.mkdirSync(telemetryDir, { recursive: true })
  fs.writeFileSync(
    path.join(telemetryDir, '2026-06-26.jsonl'),
    `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`,
  )
  return path.join(dir, 'telemetry')
}

function agentRunEnvelope(overrides: Record<string, unknown> = {}) {
  const metrics = {
    totalTurns: 3,
    completedTurns: 3,
    modelCallCount: 2,
    toolCallCount: 5,
    inputTokens: 120,
    outputTokens: 30,
    cacheReadInputTokens: 10,
    estimatedCostUsd: 0.012,
    ...((overrides.metrics as Record<string, unknown> | undefined) ?? {}),
  }

  return {
    schemaVersion: 2,
    envelopeId: `env-${overrides.runId ?? 'telemetry-run-1'}`,
    runId: overrides.runId ?? 'telemetry-run-1',
    timestamp: '2026-06-26T12:00:00.000Z',
    source: {
      repo: 'browser-agent-driver',
      cwd: '/repo',
      gitSha: COMMIT_SHA,
      gitBranch: 'test',
      cliVersion: '0.34.0',
      invocation: 'run',
    },
    model: overrides.model ?? { provider: 'openai', name: MODEL_SNAPSHOT },
    kind: overrides.kind ?? 'agent-run',
    ok: overrides.ok ?? true,
    durationMs: overrides.durationMs ?? 3000,
    data: {
      eventType: 'run-summary',
      phase: 'run',
      status: 'completed',
      totalTurns: 3,
      ...((overrides.data as Record<string, unknown> | undefined) ?? {}),
    },
    metrics,
    tags: {
      eventType: 'run-summary',
      phase: 'run',
      status: 'completed',
      ...((overrides.tags as Record<string, unknown> | undefined) ?? {}),
    },
    ...(typeof overrides.error === 'string' ? { error: overrides.error } : {}),
  }
}
