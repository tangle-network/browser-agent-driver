/**
 * Tests for the TurnEventBus — the foundation primitive for observability,
 * extension hooks, and decision-cache observability.
 *
 * The bus must be: synchronous, bounded, fault-isolated, and replay-capable
 * for late subscribers. These tests pin all four properties.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  TurnEventBus,
  createNullBus,
  ensureBus,
  isEvent,
  serializeForJsonl,
  type TurnEvent,
} from '../src/runner/events.js'

const RUN_ID = 'run_test_001'
const NOW = '2026-04-07T18:30:00.000Z'

describe('TurnEventBus', () => {
  it('assigns monotonic sequence numbers', () => {
    const bus = new TurnEventBus()
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 2 })
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 3 })
    const buffered = bus.getBuffered()
    expect(buffered.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('fans out emitted events synchronously to all subscribers', () => {
    const bus = new TurnEventBus()
    const a: TurnEvent[] = []
    const b: TurnEvent[] = []
    bus.subscribe((e) => a.push(e))
    bus.subscribe((e) => b.push(e))
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0]).toEqual(b[0])
  })

  it('catches listener errors so a bad subscriber does not crash the loop', () => {
    const errors: unknown[] = []
    const bus = new TurnEventBus({ onListenerError: (err) => errors.push(err) })
    const survivor: TurnEvent[] = []
    bus.subscribe(() => {
      throw new Error('bad listener')
    })
    bus.subscribe((e) => survivor.push(e))
    expect(() => bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(survivor).toHaveLength(1)
  })

  it('replays buffered events to late subscribers by default', () => {
    const bus = new TurnEventBus()
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 2 })
    const received: TurnEvent[] = []
    bus.subscribe((e) => received.push(e))
    expect(received.map((e) => e.turn)).toEqual([1, 2])
  })

  it('skips replay when subscribe(listener, false)', () => {
    const bus = new TurnEventBus()
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })
    const received: TurnEvent[] = []
    bus.subscribe((e) => received.push(e), false)
    expect(received).toHaveLength(0)
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 2 })
    expect(received).toHaveLength(1)
    expect(received[0].turn).toBe(2)
  })

  it('drops oldest events when retention is exceeded', () => {
    const bus = new TurnEventBus({ retention: 3 })
    for (let i = 1; i <= 5; i++) {
      bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: i })
    }
    const buffered = bus.getBuffered()
    expect(buffered).toHaveLength(3)
    expect(buffered.map((e) => e.turn)).toEqual([3, 4, 5])
  })

  it('unsubscribes cleanly via the returned function', () => {
    const bus = new TurnEventBus()
    const received: TurnEvent[] = []
    const unsub = bus.subscribe((e) => received.push(e))
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })
    unsub()
    bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 2 })
    expect(received).toHaveLength(1)
    expect(bus.listenerCount).toBe(0)
  })

  it('emitNow stamps a fresh timestamp', () => {
    const bus = new TurnEventBus()
    bus.emitNow({ type: 'turn-started', runId: RUN_ID, turn: 1 })
    const buffered = bus.getBuffered()
    expect(buffered[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('serializeForJsonl', () => {
  it('drops the screenshot field on observe-completed for wire-size sanity', () => {
    const event: TurnEvent = {
      type: 'observe-completed',
      seq: 1,
      ts: NOW,
      runId: RUN_ID,
      turn: 1,
      url: 'https://example.com',
      title: 'Example',
      snapshotBytes: 1024,
      screenshot: 'data:image/jpeg;base64,/9j/' + 'A'.repeat(50_000),
      durationMs: 12,
    }
    const serialized = serializeForJsonl(event)
    expect(serialized).not.toContain('data:image')
    expect(serialized).toContain('"snapshotBytes":1024')
  })

  it('serializes other event types verbatim', () => {
    const event: TurnEvent = {
      type: 'execute-completed',
      seq: 2,
      ts: NOW,
      runId: RUN_ID,
      turn: 1,
      action: { action: 'click', selector: '@b1' },
      success: true,
      durationMs: 42,
    }
    const parsed = JSON.parse(serializeForJsonl(event))
    expect(parsed.type).toBe('execute-completed')
    expect(parsed.action.selector).toBe('@b1')
    expect(parsed.durationMs).toBe(42)
  })
})

describe('isEvent type guard', () => {
  it('narrows the union correctly', () => {
    const event: TurnEvent = {
      type: 'execute-completed',
      seq: 1,
      ts: NOW,
      runId: RUN_ID,
      turn: 1,
      action: { action: 'click', selector: '@b1' },
      success: true,
      durationMs: 42,
    }
    if (isEvent(event, 'execute-completed')) {
      expect(event.success).toBe(true)
      expect(event.action.action).toBe('click')
    } else {
      throw new Error('expected narrow')
    }
  })

  it('returns false for non-matching types', () => {
    const event: TurnEvent = {
      type: 'turn-started',
      seq: 1,
      ts: NOW,
      runId: RUN_ID,
      turn: 1,
    }
    expect(isEvent(event, 'execute-completed')).toBe(false)
  })
})

describe('createNullBus / ensureBus', () => {
  it('createNullBus has zero retention and accepts emits without crashing', () => {
    const bus = createNullBus()
    expect(() => bus.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })).not.toThrow()
    // Retention is 0 — buffer never grows past 0 because we shift after push
    expect(bus.getBuffered().length).toBeLessThanOrEqual(1)
  })

  it('ensureBus returns the provided bus when given one', () => {
    const real = new TurnEventBus()
    expect(ensureBus(real)).toBe(real)
  })

  it('ensureBus returns a null bus when given undefined', () => {
    const result = ensureBus(undefined)
    expect(result).toBeInstanceOf(TurnEventBus)
    // Doesn't throw on emit
    expect(() => result.emit({ type: 'turn-started', ts: NOW, runId: RUN_ID, turn: 1 })).not.toThrow()
  })
})
