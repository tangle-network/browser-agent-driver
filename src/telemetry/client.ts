/**
 * Telemetry client — process-singleton gate over the sinks.
 *
 * Use `getTelemetry()` from anywhere in the codebase. The first call wires
 * sinks based on env:
 *   - BAD_TELEMETRY=0|off|false                 disable everything
 *   - BAD_TELEMETRY_DIR=/path                    local file root (default ~/.bad/telemetry)
 *   - BAD_TELEMETRY_ENDPOINT=https://...         optional remote POST
 *   - BAD_TELEMETRY_BEARER=...                   bearer token for the endpoint
 *
 * Why a singleton: every CLI invocation should see the same sink, and
 * subscribers (audit pipeline, evolve loop, GEPA) may be on different code
 * paths but share one runId. Globals are usually a smell; for cross-cutting
 * observability they're the standard.
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FanoutTelemetrySink,
  FileTelemetrySink,
  HttpTelemetrySink,
  NullTelemetrySink,
  defaultTelemetryDir,
  type TelemetrySink,
} from './sink.js'
import type { TelemetryEnvelope, TelemetryKind, TelemetryModel, TelemetrySource } from './schema.js'
import { TELEMETRY_SCHEMA_VERSION } from './schema.js'

let singleton: TelemetryClient | null = null
let cachedSource: TelemetrySource | null = null
let cliVersion = '0.0.0'

export interface EmitArgs {
  kind: TelemetryKind
  runId: string
  parentRunId?: string
  ok: boolean
  durationMs: number
  data?: Record<string, unknown>
  metrics?: Record<string, number>
  tags?: Record<string, string>
  model?: TelemetryModel
  error?: string
}

/**
 * Resolve the parentRunId for a child envelope. Order:
 *   1. explicit args.parentRunId
 *   2. BAD_PARENT_RUN_ID env var (host-injected for sandbox runs)
 */
function resolveParentRunId(explicit?: string): string | undefined {
  if (explicit) return explicit
  const fromEnv = process.env.BAD_PARENT_RUN_ID?.trim()
  return fromEnv || undefined
}

export class TelemetryClient {
  constructor(private readonly sink: TelemetrySink) {}

  emit(args: EmitArgs): void {
    const parentRunId = resolveParentRunId(args.parentRunId)
    const envelope: TelemetryEnvelope = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      envelopeId: randomUUID(),
      runId: args.runId,
      timestamp: new Date().toISOString(),
      source: getSource(),
      kind: args.kind,
      ok: args.ok,
      durationMs: args.durationMs,
      data: args.data ?? {},
      metrics: args.metrics ?? {},
      ...(parentRunId ? { parentRunId } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.tags ? { tags: args.tags } : {}),
      ...(args.error ? { error: args.error } : {}),
    }
    try {
      this.sink.emit(envelope)
    } catch {
      // swallow — telemetry never breaks the calling code path
    }
  }

  async close(): Promise<void> {
    await this.sink.close?.()
  }
}

export function getTelemetry(): TelemetryClient {
  if (singleton) return singleton
  singleton = new TelemetryClient(buildSink())
  return singleton
}

/** Override for tests + benches that want their own sink. */
export function setTelemetryClient(client: TelemetryClient): void {
  singleton = client
}

export function resetTelemetryClient(): void {
  singleton = null
  cachedSource = null
}

export function setCliVersion(v: string): void {
  cliVersion = v
}

function buildSink(): TelemetrySink {
  const flag = (process.env.BAD_TELEMETRY ?? '').toLowerCase()
  if (flag === '0' || flag === 'off' || flag === 'false' || flag === 'no') {
    return new NullTelemetrySink()
  }
  const sinks: TelemetrySink[] = []
  try {
    sinks.push(new FileTelemetrySink(defaultTelemetryDir()))
  } catch {
    // dir not writable — fall through to null
  }
  const endpoint = process.env.BAD_TELEMETRY_ENDPOINT?.trim()
  if (endpoint) {
    sinks.push(new HttpTelemetrySink(endpoint, process.env.BAD_TELEMETRY_BEARER?.trim()))
  }
  if (sinks.length === 0) return new NullTelemetrySink()
  return new FanoutTelemetrySink(sinks)
}

function getSource(): TelemetrySource {
  if (cachedSource) {
    return { ...cachedSource, invocation: cachedSource.invocation }
  }
  const cwd = process.cwd()
  // BAD_SOURCE_REPO override takes precedence — useful inside sandbox/container
  // runs where cwd is something like /workspace and `git remote -v` is meaningless.
  const repo = process.env.BAD_SOURCE_REPO?.trim() || inferRepoName(cwd)
  // Skip the two child_process calls when the host already told us what we are.
  const { gitSha, gitBranch } = process.env.BAD_SOURCE_REPO ? {} : inferGit(cwd)
  const tenantId = process.env.BAD_TENANT_ID?.trim()
  const customerId = process.env.BAD_CUSTOMER_ID?.trim()
  const apiKeyHash = process.env.BAD_API_KEY_HASH?.trim()
  cachedSource = {
    repo,
    cwd,
    cliVersion,
    invocation: process.env.BAD_INVOCATION || 'unknown',
    ...(gitSha ? { gitSha } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(customerId ? { customerId } : {}),
    ...(apiKeyHash ? { apiKeyHash } : {}),
  }
  return cachedSource
}

export function setInvocation(label: string, argv?: string[]): void {
  // Allow the CLI to label each run accurately once it knows what it's doing.
  if (!cachedSource) getSource()
  if (cachedSource) {
    cachedSource.invocation = label
    if (argv) cachedSource.argv = sanitiseArgv(argv)
  }
}

function inferRepoName(cwd: string): string {
  // Prefer git remote basename → falls back to package.json `name` → cwd basename.
  try {
    const url = execSync('git config --get remote.origin.url', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    if (url) {
      const m = url.match(/([^/:]+?)(?:\.git)?$/)
      if (m?.[1]) return m[1]
    }
  } catch {
    /* not a git repo */
  }
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string }
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, '')
    }
  } catch {
    /* no package.json or unreadable */
  }
  return path.basename(cwd) || 'unknown'
}

function inferGit(cwd: string): { gitSha?: string; gitBranch?: string } {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return { gitSha: sha || undefined, gitBranch: branch || undefined }
  } catch {
    return {}
  }
}

const SECRET_FLAGS = new Set(['--api-key', '--bearer', '--token', '--password'])
function sanitiseArgv(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (SECRET_FLAGS.has(a)) {
      out.push(a, '<redacted>')
      i++
      continue
    }
    if (/^(?:--api-key|--bearer|--token|--password)=/.test(a)) {
      out.push(a.replace(/=.*$/, '=<redacted>'))
      continue
    }
    out.push(a)
  }
  return out
}
