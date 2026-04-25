/**
 * Telemetry sinks — destinations for envelopes.
 *
 * The default policy emits to two sinks:
 *   1. Local file at `${BAD_TELEMETRY_DIR ?? ~/.bad/telemetry}/<repo>/<date>.jsonl`
 *      — always on, cheap, survives across machines via dotfiles/sync.
 *   2. HTTP POST to `BAD_TELEMETRY_ENDPOINT` if set — for fleet rollups.
 *
 * Both sinks are best-effort: a failure here MUST NOT break the calling
 * invocation. Telemetry is observability, not a feature.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TelemetryEnvelope } from './schema.js'

export interface TelemetrySink {
  emit(envelope: TelemetryEnvelope): Promise<void> | void
  close?(): Promise<void> | void
}

/** Append envelopes to a JSONL file rolling by date and repo. */
export class FileTelemetrySink implements TelemetrySink {
  private streams = new Map<string, fs.WriteStream>()

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  emit(envelope: TelemetryEnvelope): void {
    const date = envelope.timestamp.slice(0, 10) // YYYY-MM-DD
    const repo = envelope.source.repo || 'unknown'
    const key = `${repo}/${date}`
    let stream = this.streams.get(key)
    if (!stream) {
      const dir = path.join(this.baseDir, repo)
      fs.mkdirSync(dir, { recursive: true })
      stream = fs.createWriteStream(path.join(dir, `${date}.jsonl`), { flags: 'a', encoding: 'utf-8' })
      this.streams.set(key, stream)
    }
    stream.write(`${JSON.stringify(envelope)}\n`)
  }

  async close(): Promise<void> {
    const closes = Array.from(this.streams.values()).map(
      (s) => new Promise<void>((resolve) => s.end(() => resolve())),
    )
    this.streams.clear()
    await Promise.all(closes)
  }
}

/** Best-effort POST to a remote collector. Batches small payloads via fetch. */
export class HttpTelemetrySink implements TelemetrySink {
  private inflight = new Set<Promise<void>>()

  constructor(
    private readonly endpoint: string,
    private readonly bearer?: string,
  ) {}

  emit(envelope: TelemetryEnvelope): void {
    const body = JSON.stringify(envelope)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`
    const promise = fetch(this.endpoint, { method: 'POST', headers, body })
      .then(() => undefined)
      .catch(() => undefined)
    this.inflight.add(promise)
    promise.finally(() => this.inflight.delete(promise))
  }

  async close(): Promise<void> {
    await Promise.allSettled(Array.from(this.inflight))
  }
}

/** Fanout to multiple sinks — failures in one do not affect others. */
export class FanoutTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}

  emit(envelope: TelemetryEnvelope): void {
    for (const sink of this.sinks) {
      try {
        const result = sink.emit(envelope)
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          ;(result as Promise<unknown>).catch(() => undefined)
        }
      } catch {
        // swallow — telemetry must never break a run
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => Promise.resolve(s.close?.())))
  }
}

/** No-op sink — used when telemetry is explicitly disabled. */
export class NullTelemetrySink implements TelemetrySink {
  emit(): void {}
}

export function defaultTelemetryDir(): string {
  return process.env.BAD_TELEMETRY_DIR || path.join(os.homedir(), '.bad', 'telemetry')
}
