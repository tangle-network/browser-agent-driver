/**
 * Tests for FilesystemSink's events.jsonl persistence.
 *
 * Pins:
 *   - appendEvent writes one JSON line per event
 *   - the file lives at <baseDir>/<testId>/events.jsonl
 *   - close() flushes any open streams
 *   - closeEventStream() flushes a single stream
 *   - serializeForJsonl semantics survive (screenshot data URLs stripped)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { FilesystemSink } from '../src/artifacts/filesystem-sink.js'
import type { TurnEvent } from '../src/runner/events.js'

const NOW = '2026-04-08T00:00:00Z'
const RUN_ID = 'run_test'

function makeTurnEvent(turn: number): TurnEvent {
  return {
    type: 'turn-started',
    seq: turn,
    ts: NOW,
    runId: RUN_ID,
    turn,
  }
}

describe('FilesystemSink.appendEvent', () => {
  let baseDir: string

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-fs-events-'))
  })

  afterAll(() => {
    try {
      fs.rmSync(baseDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes one JSON line per event under <baseDir>/<testId>/events.jsonl', async () => {
    const sink = new FilesystemSink(path.join(baseDir, 'case-1'))
    sink.appendEvent('test-a', makeTurnEvent(1))
    sink.appendEvent('test-a', makeTurnEvent(2))
    sink.appendEvent('test-a', makeTurnEvent(3))
    await sink.closeEventStream('test-a')

    const file = path.join(baseDir, 'case-1', 'test-a', 'events.jsonl')
    expect(fs.existsSync(file)).toBe(true)
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed.map((e) => e.turn)).toEqual([1, 2, 3])
  })

  it('routes events to per-testId files', async () => {
    const sink = new FilesystemSink(path.join(baseDir, 'case-2'))
    sink.appendEvent('test-x', makeTurnEvent(1))
    sink.appendEvent('test-y', makeTurnEvent(1))
    sink.appendEvent('test-x', makeTurnEvent(2))
    await sink.close()

    const xLines = fs
      .readFileSync(path.join(baseDir, 'case-2', 'test-x', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    const yLines = fs
      .readFileSync(path.join(baseDir, 'case-2', 'test-y', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(xLines).toHaveLength(2)
    expect(yLines).toHaveLength(1)
  })

  it('strips screenshot data URLs from observe-completed events', async () => {
    const sink = new FilesystemSink(path.join(baseDir, 'case-3'))
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
    sink.appendEvent('test', event)
    await sink.close()

    const content = fs.readFileSync(
      path.join(baseDir, 'case-3', 'test', 'events.jsonl'),
      'utf-8',
    )
    expect(content).not.toContain('data:image')
    expect(content).toContain('"snapshotBytes":1024')
  })

  it('close() flushes all open streams', async () => {
    const sink = new FilesystemSink(path.join(baseDir, 'case-4'))
    sink.appendEvent('a', makeTurnEvent(1))
    sink.appendEvent('b', makeTurnEvent(1))
    sink.appendEvent('c', makeTurnEvent(1))
    // Do NOT call closeEventStream — only close() should flush all three
    await sink.close()
    expect(fs.existsSync(path.join(baseDir, 'case-4', 'a', 'events.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'case-4', 'b', 'events.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'case-4', 'c', 'events.jsonl'))).toBe(true)
  })
})
