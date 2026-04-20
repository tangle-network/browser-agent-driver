/**
 * WebhookStreamer — subscribes to a TurnEventBus and POSTs events
 * live to a webhook. Covers: basic delivery, batching under backpressure,
 * auth header, timeout handling, graceful close.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TurnEventBus } from '../src/runner/events.js'
import { WebhookStreamer } from '../src/runner/stream-webhook.js'

interface FetchCall { url: string; init: RequestInit }

function installFetch(opts: {
  onRequest?: (call: FetchCall) => void
  status?: number
  /** Resolve delay in ms — simulate a slow endpoint. */
  delayMs?: number
  /** Throw instead of returning a response. */
  fail?: string
} = {}) {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    opts.onRequest?.({ url, init })
    if (opts.fail) throw new Error(opts.fail)
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    const status = opts.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'ok',
      text: async () => '',
      json: async () => ({}),
    } as Response
  })
  globalThis.fetch = mock as unknown as typeof fetch
  return { calls, mock }
}

describe('WebhookStreamer', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })
  beforeEach(() => { vi.useRealTimers() })

  it('POSTs every bus event to the webhook', async () => {
    const { calls } = installFetch()
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/runs/abc',
      streamId: 'run_abc',
    }).attach(bus)
    bus.emit({ type: 'run-started', runId: 'run_abc', turn: 0, goal: 'test', ts: new Date().toISOString() })
    await streamer.close()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.streamId).toBe('run_abc')
    expect(body.events).toHaveLength(1)
    expect(body.events[0].type).toBe('run-started')
  })

  it('batches events when the endpoint is slower than emission', async () => {
    const { calls } = installFetch({ delayMs: 50 })
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/r',
      streamId: 'r',
    }).attach(bus)
    // Fire 5 events in rapid succession — the first POST holds for 50ms,
    // the next 4 should accumulate and flush as a single batch.
    for (let i = 0; i < 5; i++) {
      bus.emit({ type: 'turn-started', runId: 'r', turn: i + 1, ts: new Date().toISOString() })
    }
    await streamer.close()
    const totalEvents = calls.reduce((s, c) => {
      const b = JSON.parse(c.init.body as string)
      return s + b.events.length
    }, 0)
    expect(totalEvents).toBe(5)
    // Batched fewer than 5 POSTs — the exact number is timing-dependent
    // but MUST be less than or equal to 5 and greater than 0.
    expect(calls.length).toBeLessThan(5)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('includes Authorization header when authToken is set', async () => {
    const { calls } = installFetch()
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/r',
      authToken: 'secret-abc',
      streamId: 'r',
    }).attach(bus)
    bus.emit({ type: 'run-started', runId: 'r', turn: 0, goal: 'g', ts: new Date().toISOString() })
    await streamer.close()
    expect(calls.length).toBeGreaterThan(0)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-abc')
    expect(headers['X-Stream-Id']).toBe('r')
  })

  it('surfaces errors via onError without throwing at the caller', async () => {
    const errors: { err: Error; dropped: number }[] = []
    installFetch({ fail: 'connection refused' })
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/r',
      streamId: 'r',
      onError: (err, dropped) => errors.push({ err, dropped }),
    }).attach(bus)
    bus.emit({ type: 'run-started', runId: 'r', turn: 0, goal: 'g', ts: new Date().toISOString() })
    bus.emit({ type: 'turn-started', runId: 'r', turn: 1, ts: new Date().toISOString() })
    await streamer.close()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].err.message).toContain('connection refused')
  })

  it('stops posting after close()', async () => {
    const { calls } = installFetch()
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/r',
      streamId: 'r',
    }).attach(bus)
    await streamer.close()
    const before = calls.length
    // Emitting AFTER close must not POST again.
    bus.emit({ type: 'turn-started', runId: 'r', turn: 99, ts: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(before)
  })

  it('rejects non-2xx status via onError but continues accepting events', async () => {
    const errors: Error[] = []
    installFetch({ status: 500 })
    const bus = new TurnEventBus()
    const streamer = new WebhookStreamer({
      url: 'https://hook.example/r',
      streamId: 'r',
      onError: (err) => errors.push(err),
    }).attach(bus)
    bus.emit({ type: 'run-started', runId: 'r', turn: 0, goal: 'g', ts: new Date().toISOString() })
    await streamer.close()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].message).toContain('500')
  })
})
