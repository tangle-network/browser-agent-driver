/**
 * Turn event bus — typed pub/sub for sub-turn agent events.
 *
 * The agent loop emits events at every phase boundary so subscribers can
 * observe (live viewer SSE), persist (events.jsonl sink), and react (user
 * extensions). All three consume the same event stream.
 *
 * Design decisions:
 *   - In-process only. Cross-process is the SSE server's job, not the bus.
 *   - Bounded retention (last N events buffered for late subscribers).
 *   - Synchronous fanout. Listeners that need async work do it themselves.
 *   - Listener errors are caught and logged — one bad subscriber must not
 *     crash the loop.
 *   - Each event is plain JSON-serializable (no class instances, no Buffers).
 *     This is so events.jsonl can serialize them without surgery.
 *
 * The Turn type from ../types.ts is the COMPLETED-turn artifact (what
 * `onTurn` callbacks consume). TurnEvent is the live, sub-turn stream.
 */

import type { Action, PageState, Plan, Turn } from '../types.js'

// ── Event payload types ─────────────────────────────────────────────────

/** A discriminated union of every event the runner emits. */
export type TurnEvent =
  | RunStartedEvent
  | TurnStartedEvent
  | ObserveStartedEvent
  | ObserveCompletedEvent
  | DecideStartedEvent
  | DecideTokenEvent
  | DecideCompletedEvent
  | DecideSkippedCachedEvent
  | DecideSkippedPatternEvent
  | ExecuteStartedEvent
  | ExecuteCompletedEvent
  | VerifyStartedEvent
  | VerifyCompletedEvent
  | RecoveryFiredEvent
  | OverrideAppliedEvent
  | TurnCompletedEvent
  | RunCompletedEvent
  | PlanStartedEvent
  | PlanCompletedEvent
  | PlanStepExecutedEvent
  | PlanDeviatedEvent
  | PlanFallbackEnteredEvent
  | PlanReplanStartedEvent

interface BaseEvent {
  /** Monotonic sequence number, assigned by the bus on emit */
  seq: number
  /** ISO 8601 timestamp */
  ts: string
  /** The agent run ID this event belongs to */
  runId: string
  /** 1-indexed turn number, or 0 for run-level events */
  turn: number
}

export interface RunStartedEvent extends BaseEvent {
  type: 'run-started'
  goal: string
  startUrl?: string
  maxTurns: number
}

export interface TurnStartedEvent extends BaseEvent {
  type: 'turn-started'
}

export interface ObserveStartedEvent extends BaseEvent {
  type: 'observe-started'
}

export interface ObserveCompletedEvent extends BaseEvent {
  type: 'observe-completed'
  url: string
  title: string
  /** Snapshot byte length (don't send the snapshot itself — too big for the wire) */
  snapshotBytes: number
  /** Latest screenshot as a data URL, when vision is on */
  screenshot?: string
  durationMs: number
}

export interface DecideStartedEvent extends BaseEvent {
  type: 'decide-started'
}

/** Emitted while the LLM is streaming tokens, for the live viewer's spinner. */
export interface DecideTokenEvent extends BaseEvent {
  type: 'decide-token'
  /** Cumulative tokens emitted so far (not the latest token text). */
  tokenCount: number
}

export interface DecideCompletedEvent extends BaseEvent {
  type: 'decide-completed'
  action: Action
  reasoning?: string
  expectedEffect?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  durationMs: number
}

/** The decision was served from the in-session cache; no LLM call fired. */
export interface DecideSkippedCachedEvent extends BaseEvent {
  type: 'decide-skipped-cached'
  action: Action
  /** SHA1 hash of the state key that hit */
  cacheKey: string
}

/** A deterministic UI pattern matched; no LLM call fired. */
export interface DecideSkippedPatternEvent extends BaseEvent {
  type: 'decide-skipped-pattern'
  action: Action
  patternId: string
}

export interface ExecuteStartedEvent extends BaseEvent {
  type: 'execute-started'
  action: Action
}

export interface ExecuteCompletedEvent extends BaseEvent {
  type: 'execute-completed'
  action: Action
  success: boolean
  error?: string
  /** Bounding box of the target element, when known (for replay overlays) */
  bounds?: { x: number; y: number; width: number; height: number }
  durationMs: number
}

export interface VerifyStartedEvent extends BaseEvent {
  type: 'verify-started'
  expectedEffect: string
}

export interface VerifyCompletedEvent extends BaseEvent {
  type: 'verify-completed'
  verified: boolean
  reason?: string
  durationMs: number
}

export interface RecoveryFiredEvent extends BaseEvent {
  type: 'recovery-fired'
  strategy: string
  feedback: string
  forcedAction?: string
}

export interface OverrideAppliedEvent extends BaseEvent {
  type: 'override-applied'
  source: 'override-pipeline' | 'extension'
  reasoningTag: string
  feedback: string
}

export interface TurnCompletedEvent extends BaseEvent {
  type: 'turn-completed'
  /** The full Turn artifact, ready for persistence */
  turnArtifact: Turn
}

export interface RunCompletedEvent extends BaseEvent {
  type: 'run-completed'
  success: boolean
  totalTurns: number
  totalMs: number
  reason?: string
}

// ── Plan-then-execute events (Gen 7) ───────────────────────────────────

/** Brain.plan() LLM call started */
export interface PlanStartedEvent extends BaseEvent {
  type: 'plan-started'
  goal: string
}

/** Brain.plan() returned a plan (or fell back to per-action on parse failure) */
export interface PlanCompletedEvent extends BaseEvent {
  type: 'plan-completed'
  /** Number of steps in the plan */
  stepCount: number
  /** The full plan body, for replay reconstruction */
  plan: Plan
  /** ms spent in the plan() LLM call */
  durationMs: number
  /** Token usage for the plan call */
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
}

/** A single plan step finished executing (success or failure) */
export interface PlanStepExecutedEvent extends BaseEvent {
  type: 'plan-step-executed'
  /** 1-indexed step number within the plan */
  stepIndex: number
  totalSteps: number
  action: Action
  /** Did the action execute without error? */
  executeSuccess: boolean
  /** Did the post-action verification pass? */
  verified: boolean
  /** Time the step took in ms (execute + verify) */
  durationMs: number
  /** Reason if verify failed */
  verifyReason?: string
}

/** Plan execution deviated — a step failed verification or the executor errored */
export interface PlanDeviatedEvent extends BaseEvent {
  type: 'plan-deviated'
  /** Which step deviated */
  stepIndex: number
  totalSteps: number
  reason: string
}

/** Runner has fallen back from plan execution to the per-action loop */
export interface PlanFallbackEnteredEvent extends BaseEvent {
  type: 'plan-fallback-entered'
  /** How many plan steps completed before fallback */
  stepsCompleted: number
  totalSteps: number
  /** What was injected into the per-action loop's extraContext */
  fallbackContext: string
}

/**
 * Gen 7.1 — runner is calling Brain.plan() AGAIN after a previous plan
 * deviated. The replan attempt re-observes the page and asks the planner
 * for a fresh plan from the new state, with the deviation summary attached
 * as extraContext so the planner can avoid the same trap. Capped at
 * `maxReplans` per run; on cap-reached the runner falls through to the
 * per-action loop instead.
 */
export interface PlanReplanStartedEvent extends BaseEvent {
  type: 'plan-replan-started'
  /** 1-indexed replan attempt number */
  replanIndex: number
  maxReplans: number
  /** Why the previous plan attempt deviated */
  reason: string
}

// ── Bus implementation ──────────────────────────────────────────────────

export type TurnEventListener = (event: TurnEvent) => void

export interface TurnEventBusOptions {
  /** Max events retained for late subscribers. Default 200. */
  retention?: number
  /** Logger for listener errors. Default console.error. */
  onListenerError?: (err: unknown, listener: TurnEventListener) => void
}

/**
 * In-process typed pub/sub for TurnEvents.
 *
 * Subscribers receive every event after subscription, plus a buffered
 * replay of the last N events (default 200) so a late-attaching SSE
 * client can catch up without missing context.
 */
export class TurnEventBus {
  private listeners = new Set<TurnEventListener>()
  private buffer: TurnEvent[] = []
  private nextSeq = 1
  private readonly retention: number
  private readonly onListenerError: NonNullable<TurnEventBusOptions['onListenerError']>

  constructor(options: TurnEventBusOptions = {}) {
    this.retention = options.retention ?? 200
    this.onListenerError = options.onListenerError ?? ((err, _) => {
      // eslint-disable-next-line no-console
      console.error('[TurnEventBus] listener threw:', err)
    })
  }

  /**
   * Emit an event. Synchronously fans out to all listeners. Listener errors
   * are caught — one bad subscriber must not crash the loop.
   *
   * The caller supplies the event without `seq` — the bus assigns it.
   *
   * The generic `E extends TurnEvent` form makes TypeScript distribute the
   * `Omit` across the union so each call site sees the right per-variant
   * shape. Without it, `Omit<TurnEvent, ...>` collapses to the intersection
   * of all variants, which is just the BaseEvent fields.
   */
  emit<E extends TurnEvent>(event: DistributiveOmit<E, 'seq'>): void {
    const full = { ...event, seq: this.nextSeq++ } as unknown as TurnEvent
    this.buffer.push(full)
    if (this.buffer.length > this.retention) {
      this.buffer.shift()
    }
    for (const listener of this.listeners) {
      try {
        listener(full)
      } catch (err) {
        this.onListenerError(err, listener)
      }
    }
  }

  /**
   * Subscribe to all future events. Returns an unsubscribe function.
   *
   * If `replayBuffered` is true (default), the new listener immediately
   * receives every event currently in the retention buffer in order. This
   * lets late subscribers (e.g., a viewer that connects mid-run) reconstruct
   * recent state without missing anything.
   */
  subscribe(listener: TurnEventListener, replayBuffered = true): () => void {
    if (replayBuffered) {
      for (const event of this.buffer) {
        try {
          listener(event)
        } catch (err) {
          this.onListenerError(err, listener)
        }
      }
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Snapshot the current buffer (for tests / debugging). */
  getBuffered(): TurnEvent[] {
    return [...this.buffer]
  }

  /** Drop all buffered events. Listeners are NOT removed. */
  clearBuffer(): void {
    this.buffer = []
  }

  /** Number of currently subscribed listeners. */
  get listenerCount(): number {
    return this.listeners.size
  }

  /** Helper for the runner: emit with an auto-filled timestamp. */
  emitNow<E extends TurnEvent>(event: DistributiveOmit<E, 'seq' | 'ts'>): void {
    // The cast is safe: E extends TurnEvent and we're adding the missing
    // ts field. The discriminated union narrowing happens at the call site.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emit({ ...(event as any), ts: new Date().toISOString() })
  }
}

/**
 * Distributive Omit — applies `Omit` across each variant of a union type
 * separately, so per-variant fields survive narrowing. Standard `Omit` on a
 * union would collapse to the intersection of property keys (the common
 * fields only), losing the discriminant.
 */
type DistributiveOmit<T, K extends keyof TurnEvent> = T extends unknown ? Omit<T, K> : never

// ── Utilities ───────────────────────────────────────────────────────────

/**
 * Stable JSON serialization of a TurnEvent for events.jsonl persistence.
 * The event is already plain JSON, but we drop the (potentially large)
 * screenshot data URL when persisting — replay reads it from the per-turn
 * report.json instead.
 */
export function serializeForJsonl(event: TurnEvent): string {
  if (event.type === 'observe-completed' && event.screenshot) {
    const { screenshot: _screenshot, ...rest } = event
    return JSON.stringify(rest)
  }
  return JSON.stringify(event)
}

/**
 * Type guard for narrowing TurnEvent unions in subscribers.
 *
 *   bus.subscribe((e) => {
 *     if (isEvent(e, 'execute-completed') && !e.success) {
 *       // e is now narrowed
 *     }
 *   })
 */
export function isEvent<T extends TurnEvent['type']>(
  event: TurnEvent,
  type: T,
): event is Extract<TurnEvent, { type: T }> {
  return event.type === type
}

/** Build a no-op bus for tests / contexts that don't need eventing. */
export function createNullBus(): TurnEventBus {
  return new TurnEventBus({ retention: 0 })
}

/**
 * Lazy-init helper: returns the provided bus or constructs a no-op bus.
 * Used by the runner so callers can opt out by passing nothing.
 */
export function ensureBus(bus?: TurnEventBus): TurnEventBus {
  return bus ?? createNullBus()
}

// Re-export PageState for type-only consumers (avoids deep import paths
// in subscriber code).
export type { PageState }
