import { describe, expect, it } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TelemetryEnvelope } from '../src/telemetry/index.js'

process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN = '1'

const { aggregate } = await import('../bench/telemetry/rollup.js')
const ROLLUP_PATH = path.resolve(__dirname, '..', 'bench', 'telemetry', 'rollup.ts')

describe('telemetry rollup - agent-run optimization metrics', () => {
  it('surfaces cost, token, latency, skip, and failure metrics for agent runs', () => {
    const summary = aggregate([
      agentRun({
        runId: 'run-1',
        ok: true,
        durationMs: 1000,
        metrics: {
          inputTokens: 100,
          outputTokens: 25,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 20,
          estimatedCostUsd: 0.00008,
          modelCallCount: 1,
          toolCallCount: 2,
          executeFailureCount: 0,
          verificationRejectionCount: 0,
          decideCacheHits: 1,
          decidePatternSkips: 0,
          snapshotBytes: 500,
          screenshotBytes: 100,
        },
      }),
      agentRun({
        runId: 'run-2',
        ok: false,
        durationMs: 3000,
        metrics: {
          inputTokens: 300,
          outputTokens: 75,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
          estimatedCostUsd: 0.00024,
          modelCallCount: 3,
          toolCallCount: 4,
          executeFailureCount: 1,
          verificationRejectionCount: 2,
          decideCacheHits: 0,
          decidePatternSkips: 1,
          snapshotBytes: 1500,
          screenshotBytes: 300,
        },
      }),
    ])

    expect(summary.totals).toMatchObject({
      repos: 1,
      totalEnvelopes: 2,
      distinctRuns: 2,
      distinctRepos: ['browser-agent-driver'],
    })

    const row = summary.byRepoKind[0]!
    expect(row).toMatchObject({
      repo: 'browser-agent-driver',
      kind: 'agent-run',
      runs: 2,
      okRate: 0.5,
      avgDurationMs: 2000,
      avgTokens: 250,
      avgInputTokens: 200,
      avgOutputTokens: 50,
      avgCacheReadInputTokens: 20,
      avgCacheCreationInputTokens: 30,
      avgEstimatedCostUsd: 0.00016,
      avgModelCalls: 2,
      avgToolCalls: 3,
      avgExecuteFailures: 0.5,
      avgVerificationRejections: 1,
      avgDecisionSkips: 1,
      avgSnapshotBytes: 1000,
      avgScreenshotBytes: 200,
    })
    expect(summary.agentIntegrity).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        issueCodes: ['missing_steps'],
      }),
      expect.objectContaining({
        runId: 'run-2',
        issueCodes: ['missing_steps', 'missing_failure_reason'],
      }),
    ])
  })

  it('flags incomplete or untrustworthy agent telemetry runs', () => {
    const summary = aggregate([
      agentStep('healthy', 'run-started'),
      agentStep('healthy', 'decide-completed', { inputTokens: 100, outputTokens: 20 }),
      agentStep('healthy', 'run-completed'),
      agentRun({
        runId: 'healthy',
        ok: true,
        durationMs: 100,
        metrics: { modelCallCount: 1, inputTokens: 100, outputTokens: 20 },
      }),
      agentStep('missing-summary', 'run-started'),
      agentStep('missing-summary', 'run-completed'),
      agentRun({
        runId: 'no-usage',
        ok: true,
        durationMs: 100,
        metrics: { modelCallCount: 0, inputTokens: 0, outputTokens: 0 },
      }),
      agentRun({
        runId: 'failed-no-reason',
        ok: false,
        durationMs: 100,
        metrics: { modelCallCount: 1, inputTokens: 1, outputTokens: 1 },
      }),
      agentStep('missing-boundaries', 'decide-completed', { inputTokens: 10, outputTokens: 5 }),
    ])

    expect(summary.agentIntegrity).toEqual([
      expect.objectContaining({
        runId: 'failed-no-reason',
        issueCodes: ['missing_steps', 'missing_failure_reason'],
      }),
      expect.objectContaining({
        runId: 'missing-boundaries',
        issueCodes: ['missing_run_summary', 'missing_run_started', 'missing_run_completed'],
        inputTokens: 10,
        outputTokens: 5,
      }),
      expect.objectContaining({
        runId: 'missing-summary',
        issueCodes: ['missing_run_summary'],
      }),
      expect.objectContaining({
        runId: 'no-usage',
        issueCodes: ['missing_steps', 'no_model_usage'],
      }),
    ])
  })

  it('keeps same run IDs isolated across repos for integrity checks', () => {
    const summary = aggregate([
      agentStep('shared-run', 'run-started', {}, 'repo-a'),
      agentStep('shared-run', 'run-completed', {}, 'repo-a'),
      agentRun({
        runId: 'shared-run',
        repo: 'repo-b',
        ok: true,
        durationMs: 100,
        metrics: { modelCallCount: 1, inputTokens: 10, outputTokens: 2 },
      }),
    ])

    expect(summary.agentIntegrity).toEqual([
      expect.objectContaining({
        repo: 'repo-a',
        runId: 'shared-run',
        issueCodes: ['missing_run_summary'],
      }),
      expect.objectContaining({
        repo: 'repo-b',
        runId: 'shared-run',
        issueCodes: ['missing_steps'],
      }),
    ])
  })

  it('prints agent optimization metrics in the local CLI summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-rollup-'))
    const repoDir = path.join(dir, 'browser-agent-driver')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(
      path.join(repoDir, '2026-06-26.jsonl'),
      JSON.stringify(agentRun({
        runId: 'run-cli',
        ok: true,
        durationMs: 1000,
        metrics: {
          inputTokens: 100,
          outputTokens: 25,
          estimatedCostUsd: 0.00008,
          modelCallCount: 1,
          toolCallCount: 2,
          executeFailureCount: 0,
          verificationRejectionCount: 0,
          decideCacheHits: 1,
          snapshotBytes: 500,
          screenshotBytes: 100,
        },
      })) + '\n',
    )

    const env = { ...process.env }
    delete env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
    const out = spawnSync('pnpm', ['exec', 'tsx', ROLLUP_PATH, '--dir', dir], { encoding: 'utf-8', env })

    expect(out.status).toBe(0)
    expect(out.stdout).toContain('Agent optimization:')
    expect(out.stdout).toContain('cost/run')
    expect(out.stdout).toContain('0.000080')
  })

  it('passes the integrity gate for complete agent telemetry', () => {
    const dir = writeTelemetry([
      agentStep('clean', 'run-started'),
      agentStep('clean', 'decide-completed', { inputTokens: 100, outputTokens: 25 }),
      agentStep('clean', 'run-completed'),
      agentRun({
        runId: 'clean',
        ok: true,
        durationMs: 1000,
        metrics: {
          inputTokens: 100,
          outputTokens: 25,
          modelCallCount: 1,
          estimatedCostUsd: 0.00008,
        },
      }),
    ])

    const out = runRollup(dir, '--fail-on-agent-integrity')

    expect(out.status).toBe(0)
    expect(out.stderr).not.toContain('agent telemetry integrity failed')
  })

  it('fails the integrity gate for incomplete agent telemetry', () => {
    const dir = writeTelemetry([
      agentRun({
        runId: 'broken',
        ok: true,
        durationMs: 1000,
        metrics: {
          inputTokens: 0,
          outputTokens: 0,
          modelCallCount: 0,
        },
      }),
    ])

    const out = runRollup(dir, '--fail-on-agent-integrity')

    expect(out.status).toBe(1)
    expect(out.stderr).toContain('agent telemetry integrity failed')
    expect(out.stderr).toContain('missing_steps')
    expect(out.stderr).toContain('no_model_usage')
  })
})

function writeTelemetry(envelopes: TelemetryEnvelope[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-rollup-'))
  const repoDir = path.join(dir, 'browser-agent-driver')
  fs.mkdirSync(repoDir, { recursive: true })
  fs.writeFileSync(
    path.join(repoDir, '2026-06-26.jsonl'),
    envelopes.map((env) => JSON.stringify(env)).join('\n') + '\n',
  )
  return dir
}

function runRollup(dir: string, ...extraArgs: string[]): SpawnSyncReturns<string> {
  const env = { ...process.env }
  delete env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
  return spawnSync('pnpm', ['exec', 'tsx', ROLLUP_PATH, '--dir', dir, ...extraArgs], { encoding: 'utf-8', env })
}

function agentRun(args: {
  runId: string
  repo?: string
  ok: boolean
  durationMs: number
  metrics: Record<string, number>
}): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: `${args.runId}-env`,
    runId: args.runId,
    timestamp: `2026-06-26T12:00:0${args.runId.endsWith('1') ? '1' : '2'}.000Z`,
    source: {
      repo: args.repo ?? 'browser-agent-driver',
      cwd: '/repo',
      cliVersion: 'test',
      invocation: 'run',
    },
    kind: 'agent-run',
    ok: args.ok,
    durationMs: args.durationMs,
    data: {},
    metrics: args.metrics,
  }
}

function agentStep(
  runId: string,
  eventType: string,
  metrics: Record<string, number> = {},
  repo = 'browser-agent-driver',
): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    envelopeId: `${runId}-${eventType}`,
    runId,
    timestamp: '2026-06-26T12:00:00.000Z',
    source: {
      repo,
      cwd: '/repo',
      cliVersion: 'test',
      invocation: 'run',
    },
    kind: 'agent-step',
    ok: true,
    durationMs: 1,
    data: { eventType },
    metrics,
    tags: { eventType },
  }
}
