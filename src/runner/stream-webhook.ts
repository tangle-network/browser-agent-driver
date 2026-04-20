/**
 * Gen 32 — live event streaming to a webhook.
 *
 * Subscribes to the run's TurnEventBus and POSTs each event as JSON to a
 * user-specified URL. Used by `bad run --stream <url>` so a remote
 * dashboard (e.g., browser.tangle.tools/runs/:id) can watch the agent
 * work in real time — no need to wait for the run to finish + upload an
 * artifact bundle.
 *
 * Design:
 *   - Fire-and-forget. A slow or dead endpoint must not stall the run.
 *   - One in-flight POST at a time per URL. If events queue up faster
 *     than the endpoint drains, we batch them into an `events[]` array
 *     in the next POST body. Prevents connection starvation.
 *   - Retries are intentionally minimal (best-effort + on-connect only).
 *     A streaming endpoint is supplementary — events.jsonl is the
 *     canonical record, always written to disk.
 *   - Authentication via a shared secret header. Keeps endpoint private
 *     without requiring a full OAuth dance for a CLI.
 */

import type { TurnEvent, TurnEventBus } from './events.js'

export interface WebhookStreamerOptions {
  /** Full URL to POST events to. e.g. https://browser.tangle.tools/api/runs/:id/stream */
  url: string
  /** Optional shared-secret token sent as `Authorization: Bearer <token>`. */
  authToken?: string
  /** Correlation ID for all events in this stream. Defaults to runId. */
  streamId?: string
  /** Per-request timeout in ms. Default 3000. */
  timeoutMs?: number
  /**
   * Called when a flush errors so the caller can log it without noisy
   * stderr. If omitted, errors are swallowed (stream is non-fatal by
   * design). The function receives the error + how many events were
   * lost (because batch retry isn't attempted — see design note above).
   */
  onError?: (err: Error, droppedCount: number) => void
}

export class WebhookStreamer {
  private readonly url: string
  private readonly authToken?: string
  private readonly streamId: string
  private readonly timeoutMs: number
  private readonly onError: NonNullable<WebhookStreamerOptions['onError']>

  private queue: TurnEvent[] = []
  private inFlight = false
  private closed = false
  private unsubscribe?: () => void

  constructor(opts: WebhookStreamerOptions & { streamId: string }) {
    this.url = opts.url
    this.authToken = opts.authToken
    this.streamId = opts.streamId
    this.timeoutMs = opts.timeoutMs ?? 3000
    this.onError = opts.onError ?? (() => { /* silent by default */ })
  }

  /**
   * Attach to a TurnEventBus. Returns the streamer so the CLI can hold a
   * handle for final flush() + close().
   */
  attach(bus: TurnEventBus): this {
    this.unsubscribe = bus.subscribe((event) => {
      if (this.closed) return
      this.queue.push(event)
      void this.tryFlush()
    }, /* replayBuffered */ true)
    return this
  }

  /**
   * Flush all queued events. Best-effort — timeout + drop on failure.
   * Safe to call while in-flight (the caller is serialized via the
   * `inFlight` flag).
   */
  async tryFlush(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return
    this.inFlight = true
    const batch = this.queue
    this.queue = []
    try {
      await this.postBatch(batch)
    } catch (err) {
      this.onError(err as Error, batch.length)
    } finally {
      this.inFlight = false
      // If more events arrived during the POST, drain them.
      if (this.queue.length > 0 && !this.closed) {
        void this.tryFlush()
      }
    }
  }

  private async postBatch(batch: TurnEvent[]): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Stream-Id': this.streamId,
    }
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ streamId: this.streamId, events: batch }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`stream POST ${res.status}: ${res.statusText}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Close the streamer: unsubscribe from the bus and attempt a final
   * flush. Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
    // Wait for any in-flight POST to finish, then flush whatever's left.
    const waitInFlight = async (): Promise<void> => {
      if (this.inFlight) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        return waitInFlight()
      }
    }
    await waitInFlight()
    if (this.queue.length > 0) {
      const batch = this.queue
      this.queue = []
      try { await this.postBatch(batch) } catch (err) { this.onError(err as Error, batch.length) }
    }
  }
}
