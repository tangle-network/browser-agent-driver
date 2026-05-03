/**
 * Pause, resume, and abort via keyboard in interactive runs.
 *
 * Registers a raw-mode stdin handler that maps three keys:
 *
 *   p   → pause the runner before the next turn
 *   r   → resume a paused run
 *   q   → abort (the same as Ctrl-C, but doesn't kill the TTY)
 *
 * The controller exposes a single `waitIfPaused()` the runner awaits at
 * the top of every turn. When the user hits `p`, the next call blocks
 * on a resume promise. On `r`, the promise resolves and the loop
 * continues. On `q`, it throws an abort signal the runner treats as a
 * graceful cancellation.
 *
 * Design notes:
 *   - Raw mode only applies to a TTY. Non-interactive runs (CI,
 *     `bad --cases ... --json`) never engage this controller.
 *   - Keyboard capture is OPT-IN via `--interrupt`. Without it, the
 *     stdin is untouched and this module is a no-op.
 *   - Keyboard capture deliberately does NOT interfere with copy/paste
 *     — we only listen for the specific bytes `p`, `r`, `q`, and let
 *     everything else fall through unmodified.
 */

import { EventEmitter } from 'node:events'

export class InterruptAborted extends Error {
  constructor() {
    super('run aborted by user (pressed q)')
    this.name = 'InterruptAborted'
  }
}

export interface InterruptControllerOptions {
  /** stdin — overridable for tests. Default: process.stdin */
  input?: NodeJS.ReadStream
  /** Called with user-facing status strings so the CLI can render them. */
  onStatus?: (msg: string) => void
}

export class InterruptController extends EventEmitter {
  private paused = false
  private aborted = false
  private resumeResolvers: Array<() => void> = []
  private input: NodeJS.ReadStream
  private onStatus: NonNullable<InterruptControllerOptions['onStatus']>
  private attached = false
  private handler = (buf: Buffer): void => this.onKey(buf)
  private prevRaw = false

  constructor(opts: InterruptControllerOptions = {}) {
    super()
    this.input = opts.input ?? process.stdin
    this.onStatus = opts.onStatus ?? (() => { /* silent */ })
  }

  /**
   * Start listening for keystrokes. Returns a detach function the
   * caller MUST invoke when the run ends (even on error) — otherwise
   * stdin stays in raw mode and the TTY is hosed.
   */
  attach(): () => void {
    if (this.attached) return () => this.detach()
    if (!this.input.isTTY) return () => { /* no-op */ }
    this.prevRaw = this.input.isRaw
    this.input.setRawMode(true)
    this.input.resume()
    this.input.on('data', this.handler)
    this.attached = true
    this.onStatus('interrupt keys: [p] pause · [r] resume · [q] abort')
    return () => this.detach()
  }

  detach(): void {
    if (!this.attached) return
    try {
      this.input.off('data', this.handler)
      this.input.setRawMode(this.prevRaw)
      if (!process.stdin.isTTY || !this.prevRaw) {
        this.input.pause()
      }
    } catch { /* best-effort on shutdown */ }
    this.attached = false
    // Release any awaiters so the runner can unwind.
    for (const r of this.resumeResolvers) r()
    this.resumeResolvers = []
  }

  /**
   * Called from the runner at the top of each turn. If the run is paused,
   * awaits resume. If aborted, throws `InterruptAborted`.
   */
  async waitIfPaused(): Promise<void> {
    if (this.aborted) throw new InterruptAborted()
    if (!this.paused) return
    await new Promise<void>((resolve) => this.resumeResolvers.push(resolve))
    if (this.aborted) throw new InterruptAborted()
  }

  /** Programmatically pause — useful from tests and SIGUSR1 handlers. */
  pause(): void {
    if (this.paused || this.aborted) return
    this.paused = true
    this.emit('pause')
    this.onStatus('⏸  paused — press [r] to resume or [q] to abort')
  }

  /** Programmatically resume. */
  resume(): void {
    if (!this.paused || this.aborted) return
    this.paused = false
    this.emit('resume')
    this.onStatus('▶  resumed')
    for (const r of this.resumeResolvers) r()
    this.resumeResolvers = []
  }

  /** Request a graceful abort. */
  abort(): void {
    if (this.aborted) return
    this.aborted = true
    this.emit('abort')
    this.onStatus('■  aborting — run will stop at the end of this turn')
    for (const r of this.resumeResolvers) r()
    this.resumeResolvers = []
  }

  get isPaused(): boolean { return this.paused }
  get isAborted(): boolean { return this.aborted }

  private onKey(buf: Buffer): void {
    // Match a single byte for p/r/q; fall through for everything else.
    // Ctrl-C (0x03) from raw mode — forward as abort, else the process stays alive.
    if (buf.length === 1 && buf[0] === 0x03) {
      this.abort()
      return
    }
    const ch = buf.toString('utf-8')
    if (ch === 'p' || ch === 'P') this.pause()
    else if (ch === 'r' || ch === 'R') this.resume()
    else if (ch === 'q' || ch === 'Q') this.abort()
  }
}
