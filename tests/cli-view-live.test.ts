/**
 * Tests for the live SSE view server.
 *
 * Pins the SSE wire format, the /events round-trip from a TurnEventBus,
 * the /cancel POST handling, and the late-subscriber replay behavior.
 *
 * These tests use real http connections to the local server (not mocks)
 * because the SSE response writer interacts with Node's stream layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { TurnEventBus, type TurnEvent } from '../src/runner/events.js'
import { runLiveView, formatSseEvent, type LiveViewHandle } from '../src/cli-view-live.js'

const RUN_ID = 'run_test'
const NOW = '2026-04-07T19:00:00Z'

function makeEvent(turn: number): TurnEvent {
  return {
    type: 'turn-started',
    seq: turn,
    ts: NOW,
    runId: RUN_ID,
    turn,
  }
}

async function readSseEvents(url: string, count: number, timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const collected: string[] = []
      let buffer = ''
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`timeout after ${timeoutMs}ms; got ${collected.length}/${count} events`))
      }, timeoutMs)
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        // Split on SSE event delimiter (blank line)
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          if (part.startsWith(':')) continue // comment / heartbeat
          collected.push(part)
          if (collected.length >= count) {
            clearTimeout(timer)
            req.destroy()
            resolve(collected)
            return
          }
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

describe('formatSseEvent', () => {
  it('formats an event as the SSE wire format with type, id, and data fields', () => {
    const event = makeEvent(1)
    const wire = formatSseEvent(event)
    expect(wire).toContain('event: turn-started')
    expect(wire).toContain('id: 1')
    expect(wire).toContain('data: {')
    expect(wire.endsWith('\n\n')).toBe(true)
  })

  it('strips screenshot data URLs from observe-completed events', () => {
    const event: TurnEvent = {
      type: 'observe-completed',
      seq: 5,
      ts: NOW,
      runId: RUN_ID,
      turn: 5,
      url: 'https://example.com',
      title: 'Example',
      snapshotBytes: 1024,
      screenshot: 'data:image/jpeg;base64,/9j/' + 'A'.repeat(50_000),
      durationMs: 12,
    }
    const wire = formatSseEvent(event)
    expect(wire).not.toContain('data:image/jpeg')
    expect(wire).toContain('"snapshotBytes":1024')
  })
})

describe('runLiveView SSE round-trip', () => {
  let handle: LiveViewHandle | undefined
  let bus: TurnEventBus

  beforeEach(() => {
    bus = new TurnEventBus()
  })

  afterEach(async () => {
    if (handle) {
      await handle.close()
      handle = undefined
    }
  })

  it('streams events emitted on the bus to a connected SSE client', async () => {
    handle = await runLiveView({ bus, port: 17801, noOpen: true, portRetries: 5 })

    // Pre-emit one event into the bus's buffer so replay fires immediately
    bus.emitNow({ type: 'turn-started', runId: RUN_ID, turn: 1 })

    const eventsPromise = readSseEvents(`${handle.url}/events`, 2)

    // Wait for the SSE client to connect, then emit a second event
    await new Promise((r) => setTimeout(r, 100))
    bus.emitNow({ type: 'turn-started', runId: RUN_ID, turn: 2 })

    const received = await eventsPromise
    expect(received).toHaveLength(2)
    expect(received[0]).toContain('event: turn-started')
    expect(received[0]).toContain('"turn":1')
    expect(received[1]).toContain('"turn":2')
  })

  it('replays buffered events to a late-connecting client', async () => {
    handle = await runLiveView({ bus, port: 17802, noOpen: true, portRetries: 5 })

    // Emit a few events BEFORE any client connects
    for (let turn = 1; turn <= 3; turn++) {
      bus.emitNow({ type: 'turn-started', runId: RUN_ID, turn })
    }

    const received = await readSseEvents(`${handle.url}/events`, 3)
    expect(received).toHaveLength(3)
    expect(received[0]).toContain('"turn":1')
    expect(received[2]).toContain('"turn":3')
  })

  it('POST /cancel calls the AbortController', async () => {
    const ctrl = new AbortController()
    handle = await runLiveView({
      bus,
      cancelController: ctrl,
      port: 17803,
      noOpen: true,
      portRetries: 5,
    })

    expect(ctrl.signal.aborted).toBe(false)

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `${handle!.url}/cancel`,
        { method: 'POST' },
        (res) => {
          if (res.statusCode === 202) resolve()
          else reject(new Error(`unexpected status ${res.statusCode}`))
          res.resume()
        },
      )
      req.on('error', reject)
      req.end()
    })

    expect(ctrl.signal.aborted).toBe(true)
  })

  it('serves the viewer HTML with live bootstrap injected', async () => {
    handle = await runLiveView({ bus, port: 17804, noOpen: true, portRetries: 5 })

    const html = await new Promise<string>((resolve, reject) => {
      http
        .get(handle!.url, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
          res.on('error', reject)
        })
        .on('error', reject)
    })

    expect(html).toContain('window.__bad_live = true')
    expect(html).toContain("new EventSource('/events')")
  })

  it('returns 404 for unknown paths', async () => {
    handle = await runLiveView({ bus, port: 17805, noOpen: true, portRetries: 5 })

    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(`${handle!.url}/unknown-path`, (res) => {
          resolve(res.statusCode ?? 0)
          res.resume()
        })
        .on('error', reject)
    })
    expect(status).toBe(404)
  })
})
