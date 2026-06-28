import { describe, expect, it } from 'vitest'
import {
  agentRunTelemetryToRunRecord,
  badAgentProfileHash,
  badTelemetryToRunRecords,
  buildBadAgentProfileCell,
} from '../bench/agent-eval/run-records.js'
import { assertRealBackend, validateRunRecord } from '@tangle-network/agent-eval'
import type { TelemetryEnvelope } from '../src/telemetry/index.js'

const COMMIT_SHA = 'c'.repeat(40)
const PROMPT_HASH = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)

describe('BAD telemetry to agent-eval RunRecord adapter', () => {
  it('converts agent-run telemetry into a validated RunRecord', () => {
    const record = agentRunTelemetryToRunRecord(agentRun(), {
      experimentId: 'exp-webvoyager-smoke',
      candidateId: 'baseline',
      seed: 7,
      scenarioId: 'webvoyager/find-github-stars',
      modelSnapshot: 'gpt-5.4@2026-06-01',
      promptHash: PROMPT_HASH,
      configHash: CONFIG_HASH,
    })

    expect(validateRunRecord(record)).toBe(record)
    expect(record.runId).toBe('run-1')
    expect(record.model).toBe('gpt-5.4@2026-06-01')
    expect(record.commitSha).toBe(COMMIT_SHA)
    expect(record.tokenUsage).toEqual({ input: 1200, output: 300, cached: 50 })
    expect(record.costUsd).toBe(0.0123)
    expect(record.outcome.searchScore).toBe(1)
    expect(record.outcome.raw).toMatchObject({
      ok: 1,
      model_calls: 2,
      tool_calls: 5,
      input_tokens: 1200,
      output_tokens: 300,
      estimated_cost_usd: 0.0123,
    })
  })

  it('marks failed runs with a zero score and preserved failure detail', () => {
    const record = agentRunTelemetryToRunRecord(
      agentRun({
        ok: false,
        error: 'planner parse failed',
        metrics: {
          executeFailureCount: 1,
          verificationRejectionCount: 1,
        },
      }),
      {
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        scenarioId: 'scenario',
        splitTag: 'holdout',
        modelSnapshot: 'claude-sonnet-4-6@2025-04-15',
        promptHash: PROMPT_HASH,
        configHash: CONFIG_HASH,
      },
    )

    expect(record.outcome.holdoutScore).toBe(0)
    expect(record.failureMode).toBe('planner parse failed')
    expect(record.outcome.raw).toMatchObject({
      ok: 0,
      execute_failures: 1,
      verification_rejections: 1,
    })
  })

  it('fails closed when model snapshots or required identity fields are missing', async () => {
    const result = await badTelemetryToRunRecords(
      [
        agentRun({ runId: 'alias-model', model: { provider: 'openai', name: 'gpt-5.4' } }),
        agentRun({ runId: 'missing-scenario' }),
        { ...agentRun({ runId: 'ignored-step' }), kind: 'agent-step' },
      ],
      {
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        scenarioId: (envelope) => (envelope.runId === 'missing-scenario' ? undefined : 'scenario'),
        modelSnapshot: (envelope) => envelope.model?.name,
        promptHash: PROMPT_HASH,
        configHash: CONFIG_HASH,
      },
    )

    expect(result.records).toHaveLength(0)
    expect(result.rejected).toEqual([
      {
        runId: 'alias-model',
        reason: 'modelSnapshot must include a dated snapshot, got "gpt-5.4"',
      },
      {
        runId: 'missing-scenario',
        reason: 'scenarioId is required',
      },
    ])
  })

  it('rejects no-model-usage runs by default so backend outages cannot look real', () => {
    expect(() =>
      agentRunTelemetryToRunRecord(
        agentRun({
          metrics: {
            modelCallCount: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        }),
        {
          experimentId: 'exp',
          candidateId: 'candidate',
          seed: 1,
          scenarioId: 'scenario',
          modelSnapshot: 'gpt-5.4@2026-06-01',
          promptHash: PROMPT_HASH,
          configHash: CONFIG_HASH,
        },
      ),
    ).toThrow('agent-run telemetry has no model usage')
  })

  it('can deliberately keep a zero-usage record for assertRealBackend to reject later', () => {
    const record = agentRunTelemetryToRunRecord(
      agentRun({
        metrics: {
          modelCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      }),
      {
        experimentId: 'exp',
        candidateId: 'candidate',
        seed: 1,
        scenarioId: 'scenario',
        modelSnapshot: 'gpt-5.4@2026-06-01',
        promptHash: PROMPT_HASH,
        configHash: CONFIG_HASH,
        requireModelUsage: false,
      },
    )

    expect(() => assertRealBackend([record])).toThrow()
  })

  it('attaches a canonical profile cell when provided', async () => {
    const agentProfile = await buildBadAgentProfileCell({
      name: 'bad-browser-agent',
      version: '0.34.0',
      provider: 'openai',
      modelSnapshot: 'gpt-5.4@2026-06-01',
      promptHash: PROMPT_HASH,
      toolNames: ['browser', 'bash'],
      harness: { id: 'browser-agent-driver', version: '0.34.0' },
      dimensions: { mode: 'smoke' },
    })
    const { records, rejected } = await badTelemetryToRunRecords([agentRun()], {
      experimentId: 'exp',
      candidateId: 'candidate',
      seed: 1,
      scenarioId: 'scenario',
      modelSnapshot: 'gpt-5.4@2026-06-01',
      promptHash: PROMPT_HASH,
      configHash: CONFIG_HASH,
      agentProfile,
    })

    expect(rejected).toEqual([])
    expect(records[0]!.agentProfile).toEqual(agentProfile)
    expect(records[0]!.agentProfile?.cellId).toMatch(/^agent-profile-cell:sha256:/)
    expect(badAgentProfileHash({
      name: 'bad-browser-agent',
      version: '0.34.0',
      modelSnapshot: 'gpt-5.4@2026-06-01',
      toolNames: ['browser', 'bash'],
    })).toMatch(/^[0-9a-f]{64}$/)
  })
})

function agentRun(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  const metrics = {
    eventCount: 20,
    totalTurns: 3,
    totalMs: 1500,
    modelCallCount: 2,
    toolCallCount: 5,
    executeFailureCount: 0,
    verificationRejectionCount: 0,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadInputTokens: 50,
    estimatedCostUsd: 0.0123,
    ...overrides.metrics,
  }

  return {
    schemaVersion: 2,
    envelopeId: `env-${overrides.runId ?? 'run-1'}`,
    timestamp: '2026-06-26T12:00:00.000Z',
    kind: 'agent-run',
    runId: overrides.runId ?? 'run-1',
    ok: overrides.ok ?? true,
    durationMs: overrides.durationMs ?? 1500,
    source: {
      repo: 'browser-agent-driver',
      cwd: '/repo',
      gitSha: COMMIT_SHA,
      gitBranch: 'test',
      cliVersion: '0.34.0',
      invocation: 'bad run <redacted>',
    },
    model: overrides.model ?? { provider: 'openai', name: 'gpt-5.4@2026-06-01' },
    data: {
      eventCounts: {},
      actionCounts: {},
      modelCounts: {},
      errorCounts: {},
      phaseDurationsMs: {},
      ...(overrides.data ?? {}),
    },
    metrics,
    tags: {
      eventType: 'run-summary',
      phase: 'run',
      status: overrides.ok === false ? 'failed' : 'completed',
      ...(overrides.tags ?? {}),
    },
    ...(overrides.error ? { error: overrides.error } : {}),
  }
}
