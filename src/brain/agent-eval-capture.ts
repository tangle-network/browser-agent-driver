import { AsyncLocalStorage } from 'node:async_hooks'
import * as path from 'node:path'
import type { ModelMessage, SystemModelMessage } from 'ai'
import {
  FileSystemRawProviderSink,
  FileSystemTraceStore,
  TraceEmitter,
  assertRunCaptured,
  throwIfRunIncomplete,
  type RawProviderEvent,
  type RawProviderSink,
  type TraceStore,
} from '@tangle-network/agent-eval'

interface CaptureFetchContext {
  runId: string
  spanId: string
  provider: string
  model: string
  rawSink: RawProviderSink
}

interface CapturedGeneration {
  text?: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    inputTokenDetails?: {
      cacheReadTokens?: number | null
      cacheWriteTokens?: number | null
    } | null
  }
}

interface CaptureConfig {
  rootDir: string
  requireIntegrity: boolean
  scenarioId: string
  candidateId?: string
}

const captureStorage = new AsyncLocalStorage<CaptureFetchContext>()
let captureSeq = 0

export function isAgentEvalCaptureConfigured(): boolean {
  return Boolean(resolveCaptureConfig())
}

export async function captureBrainGenerate<T extends CapturedGeneration>(
  args: {
    provider: string
    model: string
    system: string | SystemModelMessage[]
    messages: ModelMessage[]
  },
  fn: () => Promise<T>,
): Promise<T> {
  const config = resolveCaptureConfig()
  if (!config) return fn()

  const runId = buildRunId(config, args.provider, args.model)
  const store = new FileSystemTraceStore({ dir: path.join(config.rootDir, 'traces') })
  const rawSink = new FileSystemRawProviderSink({ dir: path.join(config.rootDir, 'raw-provider') })
  const emitter = new TraceEmitter(store, { runId })

  await emitter.startRun({
    scenarioId: config.scenarioId,
    variantId: config.candidateId,
    layer: 'app-runtime',
    modelFingerprint: `${args.provider}:${args.model}`,
    tags: {
      kind: 'brain-generate',
      provider: args.provider,
      model: args.model,
    },
  })

  const llm = await emitter.llm({
    name: 'brain.generate',
    model: args.model,
    messages: traceMessages(args.system, args.messages),
    attributes: {
      provider: args.provider,
    },
  })

  try {
    const result = await captureStorage.run({
      runId,
      spanId: llm.span.spanId,
      provider: args.provider,
      model: args.model,
      rawSink,
    }, fn)

    await llm.end({
      output: truncateText(result.text ?? '', 16_384),
      inputTokens: finiteNumber(result.usage?.inputTokens),
      outputTokens: finiteNumber(result.usage?.outputTokens),
      cachedTokens: cachedTokens(result.usage),
    })
    await emitter.endRun({ pass: true, score: 1 })
    await assertCaptureIntegrity(store, rawSink, runId, config.requireIntegrity)
    return result
  } catch (error) {
    await llm.fail(error instanceof Error ? error : String(error))
    await emitter.abortRun(error instanceof Error ? error.message : String(error))
    throw error
  }
}

export async function captureProviderFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fetcher: () => Promise<Response>,
): Promise<Response> {
  const context = captureStorage.getStore()
  if (!context) return fetcher()

  const startedAt = Date.now()
  const requestLocation = rawProviderRequestLocation(input)
  await safeRecord(context.rawSink, {
    eventId: rawEventId(context, 'request'),
    runId: context.runId,
    spanId: context.spanId,
    provider: context.provider,
    model: context.model,
    endpoint: requestLocation.endpoint,
    baseUrl: requestLocation.baseUrl,
    attemptIndex: 0,
    direction: 'request',
    timestamp: startedAt,
    redactedFields: [],
    requestHeaders: headersObject(init?.headers),
    requestBody: await bodyPreview(init?.body),
  })

  try {
    const response = await fetcher()
    await safeRecord(context.rawSink, {
      eventId: rawEventId(context, 'response'),
      runId: context.runId,
      spanId: context.spanId,
      provider: context.provider,
      model: context.model,
      endpoint: requestLocation.endpoint,
      baseUrl: requestLocation.baseUrl,
      attemptIndex: 0,
      direction: 'response',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      statusCode: response.status,
      redactedFields: [],
      responseHeaders: headersObject(response.headers),
      responseBody: await responsePreview(response),
    })
    return response
  } catch (error) {
    await safeRecord(context.rawSink, {
      eventId: rawEventId(context, 'error'),
      runId: context.runId,
      spanId: context.spanId,
      provider: context.provider,
      model: context.model,
      endpoint: requestLocation.endpoint,
      baseUrl: requestLocation.baseUrl,
      attemptIndex: 0,
      direction: 'error',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      redactedFields: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function resolveCaptureConfig(): CaptureConfig | undefined {
  const rawDir = process.env.BAD_AGENT_EVAL_CAPTURE_DIR || process.env.BAD_AGENT_EVAL_TRACE_DIR
  if (!rawDir) return undefined
  return {
    rootDir: path.resolve(rawDir),
    requireIntegrity: process.env.BAD_AGENT_EVAL_CAPTURE_REQUIRE === '1',
    scenarioId: process.env.BAD_AGENT_EVAL_SCENARIO_ID || 'brain-generate',
    candidateId: process.env.BAD_AGENT_EVAL_CANDIDATE_ID,
  }
}

function buildRunId(config: CaptureConfig, provider: string, model: string): string {
  const prefix = process.env.BAD_AGENT_EVAL_RUN_ID || `${provider}-${model}`
  captureSeq += 1
  return `${safeId(prefix)}-${Date.now()}-${captureSeq}`
}

async function assertCaptureIntegrity(
  store: TraceStore,
  rawSink: RawProviderSink,
  runId: string,
  strict: boolean,
): Promise<void> {
  const report = await assertRunCaptured(store, runId, {
    llmSpansMin: 1,
    rawSink,
    rawProviderEventsMin: 1,
    requireRawCoverageOfLlmSpans: true,
    requireOutcome: true,
  })
  if (strict) throwIfRunIncomplete(report)
}

function traceMessages(system: string | SystemModelMessage[], messages: ModelMessage[]) {
  return [
    {
      role: 'system' as const,
      content: truncateText(typeof system === 'string'
        ? system
        : system.map((part) => part.content).join('\n\n'), 16_384),
    },
    ...messages.map((message) => ({
      role: message.role === 'tool' ? 'tool' as const : message.role,
      content: traceContent(message.content),
    })),
  ]
}

function traceContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') return truncateText(content, 16_384)
  if (!Array.isArray(content)) return truncateText(String(content), 16_384)
  return truncateText(content.map((part) => {
    if ('text' in part && typeof part.text === 'string') return part.text
    if ('type' in part && part.type === 'image') return `[image:${'mediaType' in part ? part.mediaType : 'unknown'}]`
    return `[${'type' in part ? part.type : 'part'}]`
  }).join('\n'), 16_384)
}

function cachedTokens(usage: CapturedGeneration['usage']): number | undefined {
  const details = usage?.inputTokenDetails
  return finiteNumber(details?.cacheReadTokens) ?? finiteNumber(details?.cacheWriteTokens)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function headersObject(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined
  return Object.fromEntries(new Headers(headers).entries())
}

function rawProviderRequestLocation(input: RequestInfo | URL): { endpoint: string; baseUrl: string } {
  const rawUrl = requestUrl(input)
  try {
    const url = new URL(rawUrl)
    return {
      baseUrl: url.origin,
      endpoint: `${url.pathname}${url.search}` || '/',
    }
  } catch {
    return {
      baseUrl: 'unknown',
      endpoint: rawUrl || 'unknown',
    }
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

async function bodyPreview(body: BodyInit | null | undefined): Promise<unknown> {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return parseMaybeJson(truncateText(body, captureBodyBytes()))
  if (body instanceof URLSearchParams) return truncateText(body.toString(), captureBodyBytes())
  return { omitted: true, type: body.constructor?.name ?? typeof body }
}

async function responsePreview(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('json') && !contentType.startsWith('text/')) {
    return { omitted: true, contentType }
  }
  try {
    const text = await response.clone().text()
    return parseMaybeJson(truncateText(text, captureBodyBytes()))
  } catch (error) {
    return { omitted: true, error: error instanceof Error ? error.message : String(error) }
  }
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function captureBodyBytes(): number {
  const parsed = Number(process.env.BAD_AGENT_EVAL_CAPTURE_BODY_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 262_144
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} chars]`
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bad-llm'
}

function rawEventId(context: CaptureFetchContext, direction: RawProviderEvent['direction']): string {
  return `${context.runId}:${context.spanId}:${direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

async function safeRecord(sink: RawProviderSink, event: RawProviderEvent): Promise<void> {
  try {
    await sink.record(event)
  } catch {
    // Capture must not perturb the provider request. Strict integrity checks
    // fail after the model call if recording broke.
  }
}
