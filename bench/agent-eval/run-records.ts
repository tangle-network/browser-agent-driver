import {
  agentProfileHash,
  buildAgentInterfaceProfileCell,
  buildAgentProfileCell,
  validateAgentProfileCell,
  validateRunRecord,
  type AgentInterfaceProfileLike,
  type AgentProfileCell,
  type AgentProfileCellInput,
  type RunRecord,
  type RunSplitTag,
} from '@tangle-network/agent-eval'

import type { TelemetryEnvelope, TelemetryModel } from '../../src/telemetry/index.js'

export type BadRunRecordValue<T> = T | ((envelope: TelemetryEnvelope) => T | undefined)

export interface BadRunRecordAdapterOptions {
  experimentId: BadRunRecordValue<string>
  candidateId: BadRunRecordValue<string>
  seed: BadRunRecordValue<number>
  scenarioId: BadRunRecordValue<string>
  splitTag?: BadRunRecordValue<RunSplitTag>
  modelSnapshot: BadRunRecordValue<string>
  promptHash: BadRunRecordValue<string>
  configHash: BadRunRecordValue<string>
  score?: BadRunRecordValue<number>
  commitSha?: BadRunRecordValue<string>
  agentProfile?: BadAgentProfileInput
  outcomeRaw?: BadRunRecordValue<Record<string, number>>
  requireModelUsage?: boolean
}

export interface BadAgentProfileDescriptor {
  name: string
  version: string
  provider?: string
  modelSnapshot?: string
  promptInstructions?: string[]
  toolNames?: string[]
  harness?: AgentProfileCellInput['harness']
  promptHash?: string
  dimensions?: AgentProfileCellInput['dimensions']
}

export type BadAgentProfileInput =
  | AgentProfileCell
  | AgentProfileCellInput
  | AgentInterfaceProfileLike
  | BadAgentProfileDescriptor

export interface BadRunRecordConversion {
  records: RunRecord[]
  rejected: BadRunRecordRejection[]
}

export interface BadRunRecordRejection {
  runId?: string
  reason: string
}

const SNAPSHOT_PATTERN = /(?:@\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}|\d{8})$/

export async function badTelemetryToRunRecords(
  envelopes: readonly TelemetryEnvelope[],
  options: BadRunRecordAdapterOptions,
): Promise<BadRunRecordConversion> {
  const records: RunRecord[] = []
  const rejected: BadRunRecordRejection[] = []
  const agentProfile = options.agentProfile
    ? await buildBadAgentProfileCell(options.agentProfile, {
        modelSnapshot: resolveStaticValue(options.modelSnapshot),
        promptHash: resolveStaticValue(options.promptHash),
      })
    : undefined

  for (const envelope of envelopes) {
    if (envelope.kind !== 'agent-run') continue
    try {
      records.push(agentRunTelemetryToRunRecord(envelope, { ...options, agentProfile }))
    } catch (error) {
      rejected.push({
        runId: envelope.runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { records, rejected }
}

export function agentRunTelemetryToRunRecord(
  envelope: TelemetryEnvelope,
  options: Omit<BadRunRecordAdapterOptions, 'agentProfile'> & { agentProfile?: AgentProfileCell },
): RunRecord {
  if (envelope.kind !== 'agent-run') {
    throw new Error(`expected agent-run telemetry, got ${envelope.kind}`)
  }
  if (!envelope.runId) {
    throw new Error('agent-run telemetry is missing runId')
  }
  if (options.requireModelUsage !== false && metric(envelope, 'modelCallCount') <= 0) {
    throw new Error('agent-run telemetry has no model usage')
  }

  const model = requireSnapshot(resolveValue(options.modelSnapshot, envelope), envelope.model)
  const splitTag = resolveValue(options.splitTag ?? 'search', envelope)
  const score = resolveValue(options.score ?? defaultScore, envelope)
  const scenarioId = requireString('scenarioId', resolveValue(options.scenarioId, envelope))
  const promptHash = requireHash('promptHash', resolveValue(options.promptHash, envelope))
  const configHash = requireHash('configHash', resolveValue(options.configHash, envelope))
  const commitSha = requireCommitSha(resolveValue(options.commitSha, envelope) ?? envelope.source.gitSha)

  const raw = {
    ...defaultOutcomeRaw(envelope),
    ...(resolveValue(options.outcomeRaw, envelope) ?? {}),
  }

  const record: RunRecord = {
    runId: envelope.runId,
    experimentId: requireString('experimentId', resolveValue(options.experimentId, envelope)),
    candidateId: requireString('candidateId', resolveValue(options.candidateId, envelope)),
    seed: requireFiniteNumber('seed', resolveValue(options.seed, envelope)),
    model,
    promptHash,
    configHash,
    commitSha,
    wallMs: requireNonNegativeNumber('wallMs', envelope.durationMs),
    costUsd: requireNonNegativeNumber('costUsd', metric(envelope, 'estimatedCostUsd')),
    tokenUsage: {
      input: requireNonNegativeNumber('tokenUsage.input', metric(envelope, 'inputTokens')),
      output: requireNonNegativeNumber('tokenUsage.output', metric(envelope, 'outputTokens')),
      cached: requireNonNegativeNumber('tokenUsage.cached', metric(envelope, 'cacheReadInputTokens')),
    },
    outcome: {
      raw,
      ...(splitTag === 'holdout' ? { holdoutScore: score } : { searchScore: score }),
    },
    ...(envelope.ok === false
      ? {
          failureMode:
            typeof envelope.error === 'string' && envelope.error.trim()
              ? envelope.error.slice(0, 240)
              : 'agent_run_failed',
        }
      : {}),
    splitTag,
    scenarioId,
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
  }

  return validateRunRecord(record)
}

export async function buildBadAgentProfileCell(
  input: BadAgentProfileInput,
  defaults: { modelSnapshot?: string; promptHash?: string } = {},
): Promise<AgentProfileCell> {
  if (isAgentProfileCell(input)) return validateAgentProfileCell(input)
  if (isAgentProfileCellInput(input)) return buildAgentProfileCell(input)

  const descriptor = isBadAgentProfileDescriptor(input) ? input : undefined
  const profile = descriptor ? descriptorToInterfaceProfile(descriptor, defaults.modelSnapshot) : input

  return buildAgentInterfaceProfileCell(profile, {
    harness: descriptor?.harness,
    model: descriptor?.modelSnapshot ?? defaults.modelSnapshot,
    promptHash: descriptor?.promptHash ?? defaults.promptHash,
    dimensions: descriptor?.dimensions,
  })
}

export function badAgentProfileHash(input: AgentInterfaceProfileLike | BadAgentProfileDescriptor): string {
  return agentProfileHash(isBadAgentProfileDescriptor(input) ? descriptorToInterfaceProfile(input) : input)
}

function defaultScore(envelope: TelemetryEnvelope): number {
  return envelope.ok === false ? 0 : 1
}

function defaultOutcomeRaw(envelope: TelemetryEnvelope): Record<string, number> {
  return {
    ok: envelope.ok === false ? 0 : 1,
    duration_ms: envelope.durationMs,
    total_turns: metric(envelope, 'totalTurns'),
    model_calls: metric(envelope, 'modelCallCount'),
    tool_calls: metric(envelope, 'toolCallCount'),
    execute_failures: metric(envelope, 'executeFailureCount'),
    verification_rejections: metric(envelope, 'verificationRejectionCount'),
    input_tokens: metric(envelope, 'inputTokens'),
    output_tokens: metric(envelope, 'outputTokens'),
    cached_input_tokens: metric(envelope, 'cacheReadInputTokens'),
    estimated_cost_usd: metric(envelope, 'estimatedCostUsd'),
  }
}

function descriptorToInterfaceProfile(
  descriptor: BadAgentProfileDescriptor,
  defaultModelSnapshot?: string,
): AgentInterfaceProfileLike {
  const modelSnapshot = descriptor.modelSnapshot ?? defaultModelSnapshot
  return {
    name: descriptor.name,
    version: descriptor.version,
    ...(modelSnapshot || descriptor.provider
      ? {
          model: {
            ...(modelSnapshot ? { default: modelSnapshot } : {}),
            ...(descriptor.provider ? { provider: descriptor.provider } : {}),
          },
        }
      : {}),
    ...(descriptor.promptInstructions
      ? { prompt: { instructions: descriptor.promptInstructions } }
      : {}),
    ...(descriptor.toolNames
      ? { tools: Object.fromEntries(descriptor.toolNames.map((tool) => [tool, true])) }
      : {}),
  }
}

function isAgentProfileCell(input: BadAgentProfileInput): input is AgentProfileCell {
  return (
    typeof input === 'object' &&
    input !== null &&
    'schemaVersion' in input &&
    'cellId' in input &&
    'sourceProfile' in input
  )
}

function isAgentProfileCellInput(input: BadAgentProfileInput): input is AgentProfileCellInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'profileId' in input &&
    'sourceProfile' in input &&
    !('cellId' in input)
  )
}

function isBadAgentProfileDescriptor(input: BadAgentProfileInput): input is BadAgentProfileDescriptor {
  return (
    typeof input === 'object' &&
    input !== null &&
    ('provider' in input ||
      'modelSnapshot' in input ||
      'promptInstructions' in input ||
      'toolNames' in input ||
      'harness' in input ||
      'promptHash' in input ||
      'dimensions' in input)
  )
}

function resolveValue<T>(value: BadRunRecordValue<T> | undefined, envelope: TelemetryEnvelope): T | undefined {
  return typeof value === 'function' ? value(envelope) : value
}

function resolveStaticValue<T>(value: BadRunRecordValue<T>): T | undefined {
  return typeof value === 'function' ? undefined : value
}

function metric(envelope: TelemetryEnvelope, key: string): number {
  const value = envelope.metrics[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function requireString(name: string, value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

function requireSnapshot(value: string | undefined, fallback?: TelemetryModel): string {
  const model = value ?? fallback?.name
  if (!model) throw new Error('modelSnapshot is required')
  if (!SNAPSHOT_PATTERN.test(model)) {
    throw new Error(`modelSnapshot must include a dated snapshot, got "${model}"`)
  }
  return model
}

function requireHash(name: string, value: string | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 64-character hex sha256`)
  }
  return value.toLowerCase()
}

function requireCommitSha(value: string | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('commitSha must be a 40-character git SHA')
  }
  return value.toLowerCase()
}

function requireFiniteNumber(name: string, value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`)
  }
  return value
}

function requireNonNegativeNumber(name: string, value: number | undefined): number {
  const number = requireFiniteNumber(name, value)
  if (number < 0) throw new Error(`${name} must be non-negative`)
  return number
}
