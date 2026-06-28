import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT_DIR = path.resolve(__dirname, '..')

const REQUIRED_RUNTIME_EXPORTS: Record<string, readonly string[]> = {
  '@tangle-network/agent-eval': [
    'AgentProfileCellValidationError',
    'AnalystRegistry',
    'FileSystemRawProviderSink',
    'FindingsStore',
    'HeldOutGate',
    'InMemoryRawProviderSink',
    'MultiLayerVerifier',
    'NoopRawProviderSink',
    'TraceEmitter',
    'agentProfileHash',
    'appendScorecard',
    'assertLlmRoute',
    'assertRealBackend',
    'assertRunCaptured',
    'callLlm',
    'callLlmJson',
    'computeFindingId',
    'createTraceAnalystKind',
    'defaultIsMaterial',
    'diffFindings',
    'diffScorecard',
    'evaluateInterimReleaseConfidence',
    'formatScorecardDiff',
    'gainHistogram',
    'loadScorecard',
    'makeFinding',
    'pairedEvalueSequence',
    'paretoChart',
    'recordRuns',
    'recordRunsToScorecard',
    'renderPriorFindings',
    'researchReport',
    'runEvalCampaign',
    'summaryTable',
    'throwIfRunIncomplete',
    'traceAnalystOnRunComplete',
    'validateRunRecord',
    'withJudgeRetry',
  ],
  '@tangle-network/agent-eval/analyst': [
    'parseFindingSubject',
    'renderFindingSubject',
    'structureFindings',
  ],
  '@tangle-network/agent-eval/traces': [
    'FileSystemRawProviderSink',
    'FileSystemTraceStore',
    'InMemoryRawProviderSink',
    'InMemoryTraceStore',
    'NoopRawProviderSink',
    'OtlpFileTraceStore',
    'ReplayCache',
    'TraceEmitter',
    'assertRunCaptured',
    'createReplayFetch',
    'iterateRawCalls',
    'throwIfRunIncomplete',
  ],
  '@tangle-network/agent-eval/rl': [
    'applyEloUpdate',
    'bestOfN',
    'buildPairwiseFromCampaign',
    'doublyRobust',
    'extractPreferences',
    'extractStepRewards',
    'extractVerifiableReward',
    'filterDeterministicallyRewarded',
    'fitBradleyTerry',
    'inverseProbabilityWeighting',
    'offPolicyEstimateAll',
    'paretoFrontier',
    'prmTrainingPairs',
    'runComputeCurve',
    'runContaminationProbe',
    'selfConsistency',
    'selfNormalizedImportanceWeighting',
  ],
}

const TYPE_EXPORT_PROBE = `
import type { AgentProfile, RawProviderSink, RunRecord } from '@tangle-network/agent-eval'
import {
  AgentProfileCellValidationError,
  AnalystRegistry,
  FileSystemRawProviderSink,
  FindingsStore,
  HeldOutGate,
  InMemoryRawProviderSink,
  MultiLayerVerifier,
  NoopRawProviderSink,
  TraceEmitter,
  agentProfileHash,
  appendScorecard,
  assertLlmRoute,
  assertRealBackend,
  assertRunCaptured,
  callLlm,
  callLlmJson,
  computeFindingId,
  createTraceAnalystKind,
  defaultIsMaterial,
  diffFindings,
  diffScorecard,
  evaluateInterimReleaseConfidence,
  formatScorecardDiff,
  gainHistogram,
  loadScorecard,
  makeFinding,
  pairedEvalueSequence,
  paretoChart,
  recordRuns,
  recordRunsToScorecard,
  renderPriorFindings,
  researchReport,
  runEvalCampaign,
  summaryTable,
  throwIfRunIncomplete,
  traceAnalystOnRunComplete,
  validateRunRecord,
  withJudgeRetry,
} from '@tangle-network/agent-eval'
import { parseFindingSubject } from '@tangle-network/agent-eval/analyst'

const runtimeExports = [
  AgentProfileCellValidationError,
  AnalystRegistry,
  FileSystemRawProviderSink,
  FindingsStore,
  HeldOutGate,
  InMemoryRawProviderSink,
  MultiLayerVerifier,
  NoopRawProviderSink,
  TraceEmitter,
  agentProfileHash,
  appendScorecard,
  assertLlmRoute,
  assertRealBackend,
  assertRunCaptured,
  callLlm,
  callLlmJson,
  computeFindingId,
  createTraceAnalystKind,
  defaultIsMaterial,
  diffFindings,
  diffScorecard,
  evaluateInterimReleaseConfidence,
  formatScorecardDiff,
  gainHistogram,
  loadScorecard,
  makeFinding,
  pairedEvalueSequence,
  paretoChart,
  parseFindingSubject,
  recordRuns,
  recordRunsToScorecard,
  renderPriorFindings,
  researchReport,
  runEvalCampaign,
  summaryTable,
  throwIfRunIncomplete,
  traceAnalystOnRunComplete,
  validateRunRecord,
  withJudgeRetry,
]
const typed: [AgentProfile | undefined, RunRecord | undefined, RawProviderSink | undefined] = [
  undefined,
  undefined,
  undefined,
]
void runtimeExports
void typed
`

describe('agent-eval dependency surface', () => {
  it('exposes the runtime primitives BAD needs for trace-first optimization', async () => {
    const missingByModule: Record<string, string[]> = {}

    for (const [specifier, requiredNames] of Object.entries(REQUIRED_RUNTIME_EXPORTS)) {
      const moduleExports = (await import(specifier)) as Record<string, unknown>
      const missing = requiredNames.filter((name) => !(name in moduleExports))
      if (missing.length > 0) {
        missingByModule[specifier] = missing
      }
    }

    expect(missingByModule).toEqual({})
  })

  it('exposes the type-only contracts used by scorecards and raw-provider capture', () => {
    const tempDir = fs.mkdtempSync(path.join(ROOT_DIR, '.agent-eval-audit-'))
    const probePath = path.join(tempDir, 'surface-probe.ts')

    try {
      fs.writeFileSync(probePath, TYPE_EXPORT_PROBE)
      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        [
          'exec',
          'tsc',
          '--noEmit',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2022',
          '--strict',
          '--skipLibCheck',
          '--types',
          'node',
          '--pretty',
          'false',
          probePath,
        ],
        {
          cwd: ROOT_DIR,
          encoding: 'utf8',
        },
      )
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n')

      if (result.status !== 0) {
        throw new Error(output || `tsc exited with status ${result.status}`)
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true })
    }
  })
})
