/**
 * InterruptController — pause/resume/abort for interactive runs.
 *
 * Tests exercise the programmatic surface (pause/resume/abort + the
 * waitIfPaused promise). The keyboard handler is tested separately via
 * a fake stdin that emits Buffer events.
 */
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  InterruptController,
  InterruptAborted,
} from '../src/runner/interrupt-controller.js'

describe('InterruptController (programmatic)', () => {
  it('is running by default — waitIfPaused resolves immediately', async () => {
    const c = new InterruptController()
    await expect(c.waitIfPaused()).resolves.toBeUndefined()
  })

  it('pause() blocks waitIfPaused; resume() releases it', async () => {
    const c = new InterruptController()
    c.pause()
    let resolved = false
    const p = c.waitIfPaused().then(() => { resolved = true })
    // Give the microtask a tick — should NOT resolve while paused
    await new Promise((r) => setImmediate(r))
    expect(resolved).toBe(false)
    c.resume()
    await p
    expect(resolved).toBe(true)
  })

  it('abort() throws InterruptAborted from a pending waiter', async () => {
    const c = new InterruptController()
    c.pause()
    const p = c.waitIfPaused()
    c.abort()
    await expect(p).rejects.toThrow(InterruptAborted)
  })

  it('abort() throws on subsequent waitIfPaused even when not paused', async () => {
    const c = new InterruptController()
    c.abort()
    await expect(c.waitIfPaused()).rejects.toThrow(InterruptAborted)
  })

  it('multiple pause() calls are idempotent', () => {
    const c = new InterruptController()
    c.pause()
    c.pause()
    expect(c.isPaused).toBe(true)
  })

  it('resume() while not paused is a no-op', () => {
    const c = new InterruptController()
    const spy = vi.fn()
    c.on('resume', spy)
    c.resume()
    expect(spy).not.toHaveBeenCalled()
    expect(c.isPaused).toBe(false)
  })

  it('emits events for pause / resume / abort', () => {
    const c = new InterruptController()
    const events: string[] = []
    c.on('pause', () => events.push('pause'))
    c.on('resume', () => events.push('resume'))
    c.on('abort', () => events.push('abort'))
    c.pause()
    c.resume()
    c.abort()
    expect(events).toEqual(['pause', 'resume', 'abort'])
  })

  it('onStatus callback receives user-facing strings', () => {
    const msgs: string[] = []
    const c = new InterruptController({ onStatus: (m) => msgs.push(m) })
    c.pause()
    c.resume()
    c.abort()
    expect(msgs.some((m) => /paused/i.test(m))).toBe(true)
    expect(msgs.some((m) => /resumed/i.test(m))).toBe(true)
    expect(msgs.some((m) => /aborting/i.test(m))).toBe(true)
  })
})

describe('InterruptController (keyboard)', () => {
  function fakeStdin(): NodeJS.ReadStream {
    const s = Readable.from([]) as unknown as NodeJS.ReadStream & { [k: string]: unknown }
    // Simulate a TTY
    ;(s as { isTTY?: boolean }).isTTY = true
    ;(s as { isRaw?: boolean }).isRaw = false
    ;(s as { setRawMode?: (b: boolean) => void }).setRawMode = () => {}
    // Node's stream.Readable inherits EventEmitter — `on` and `off` work. We
    // expose a helper to push bytes.
    ;(s as { _emitKey?: (buf: Buffer) => void })._emitKey = (buf: Buffer) => {
      s.emit('data', buf)
    }
    return s as NodeJS.ReadStream
  }

  it('"p" pauses, "r" resumes, "q" aborts', async () => {
    const input = fakeStdin()
    const c = new InterruptController({ input })
    const detach = c.attach()
    expect(c.isPaused).toBe(false)
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from('p'))
    expect(c.isPaused).toBe(true)
    const waiter = c.waitIfPaused()
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from('r'))
    await waiter
    expect(c.isPaused).toBe(false)
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from('q'))
    expect(c.isAborted).toBe(true)
    detach()
  })

  it('Ctrl-C (byte 0x03) triggers abort', () => {
    const input = fakeStdin()
    const c = new InterruptController({ input })
    c.attach()
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from([0x03]))
    expect(c.isAborted).toBe(true)
  })

  it('ignores unknown keys', () => {
    const input = fakeStdin()
    const c = new InterruptController({ input })
    c.attach()
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from('x'))
    ;(input as { _emitKey: (b: Buffer) => void })._emitKey(Buffer.from(' '))
    expect(c.isPaused).toBe(false)
    expect(c.isAborted).toBe(false)
  })

  it('attach() is a no-op in non-TTY mode', () => {
    const input = fakeStdin()
    ;(input as { isTTY: boolean }).isTTY = false
    const c = new InterruptController({ input })
    const detach = c.attach()
    // Emitting should NOT register — but this is hard to assert directly;
    // we instead assert detach() is callable without throwing.
    expect(() => detach()).not.toThrow()
  })
})
