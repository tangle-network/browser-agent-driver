/**
 * In-session decision cache — short-circuits brain.decide() when the runner
 * encounters a state it has already seen in this run.
 *
 * Why this exists: brain.decide() fires every turn unconditionally, even when
 * the (snapshot, url, goal, last-effect, turn-budget) is byte-identical to a
 * previous turn. That happens more often than you'd think — agents back up to
 * known pages, retry after recoverable failures, or revisit a confirmation
 * step. Each of those is a 1-3 second LLM call that produces the same answer
 * the agent already gave a few turns ago.
 *
 * Cache contract:
 *   - In-session ONLY. Never persists across runs. Page state changes silently
 *     between sessions and a stale cached decision is a correctness landmine.
 *   - Bounded LRU. Default 50 entries.
 *   - TTL per entry (default 10 minutes). Lets the cache evict slow stale
 *     entries even within a long session.
 *   - Hash includes turn-budget bucket — "what would I do here at turn 18 of
 *     20" must NOT reuse "what would I do here at turn 5 of 20" because the
 *     LLM's risk tolerance changes near the budget cap.
 *   - Cache hits emit `decide-skipped-cached` events on the bus so the live
 *     viewer can flag them and the user can audit cache effectiveness.
 *
 * What is NOT cached:
 *   - The full BrainDecision is cached, but the cached value omits raw LLM
 *     output and token counts (those are run-specific telemetry, not part of
 *     the decision itself).
 *   - Recovery feedback turns are NEVER cached — they're inherently context-
 *     dependent on the failure trail.
 */

import { createHash } from 'node:crypto'
import type { BrainDecision } from '../brain/index.js'

export interface DecisionCacheOptions {
  /** Max entries before LRU eviction. Default 50. */
  maxEntries?: number
  /** Time-to-live per entry in milliseconds. Default 10 minutes. */
  ttlMs?: number
  /** Now() function for tests. Defaults to Date.now. */
  now?: () => number
}

export interface DecisionCacheKey {
  /** SHA1 of normalized snapshot text */
  snapshotHash: string
  /** Page URL */
  url: string
  /** Goal text */
  goal: string
  /** Last action's expectedEffect (empty string for first turn) */
  lastEffect: string
  /**
   * Turn budget bucket: how much of the turn budget is left, bucketed by
   * thirds (early/mid/late). The agent's strategy changes near the cap, so
   * "what to do here at turn 18/20" must not reuse "what to do here at turn
   * 5/20".
   */
  budgetBucket: 'early' | 'mid' | 'late'
}

/** A cached decision plus the metadata needed to invalidate it. */
interface CacheEntry {
  decision: BrainDecision
  storedAt: number
  hash: string
}

export class DecisionCache {
  private entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly now: () => number
  private hits = 0
  private misses = 0

  constructor(options: DecisionCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 50
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000 // 10 minutes
    this.now = options.now ?? Date.now
  }

  /** Hash a key into a stable opaque string. Exposed for tests. */
  static hashKey(key: DecisionCacheKey): string {
    const h = createHash('sha1')
    h.update(key.snapshotHash)
    h.update('\u0000')
    h.update(key.url)
    h.update('\u0000')
    h.update(key.goal)
    h.update('\u0000')
    h.update(key.lastEffect)
    h.update('\u0000')
    h.update(key.budgetBucket)
    return h.digest('hex')
  }

  /**
   * Hash a snapshot string. Done by the cache rather than the caller so
   * future cache implementations can swap the hash algorithm without
   * cascading changes.
   */
  static hashSnapshot(snapshot: string): string {
    return createHash('sha1').update(snapshot).digest('hex')
  }

  /** Bucket the turn position so cache hits respect strategic horizons. */
  static budgetBucket(currentTurn: number, maxTurns: number): 'early' | 'mid' | 'late' {
    const ratio = currentTurn / Math.max(maxTurns, 1)
    if (ratio < 0.33) return 'early'
    if (ratio < 0.75) return 'mid'
    return 'late'
  }

  /**
   * Look up a cached decision. Returns undefined on miss or stale entry.
   * Records hit/miss for `getStats()`.
   */
  get(key: DecisionCacheKey): { decision: BrainDecision; hash: string } | undefined {
    const hash = DecisionCache.hashKey(key)
    const entry = this.entries.get(hash)
    if (!entry) {
      this.misses++
      return undefined
    }
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(hash)
      this.misses++
      return undefined
    }
    // LRU bump: re-insert to mark recently used
    this.entries.delete(hash)
    this.entries.set(hash, entry)
    this.hits++
    return { decision: entry.decision, hash }
  }

  /**
   * Store a decision under the given key. Evicts the oldest entry if the
   * cache is full.
   */
  set(key: DecisionCacheKey, decision: BrainDecision): string {
    const hash = DecisionCache.hashKey(key)
    if (this.entries.size >= this.maxEntries && !this.entries.has(hash)) {
      // Evict oldest (Map iteration order = insertion order)
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(hash, {
      decision: this.stripVolatile(decision),
      storedAt: this.now(),
      hash,
    })
    return hash
  }

  /** Drop all entries. Tests + explicit cache-bust use. */
  clear(): void {
    this.entries.clear()
    this.hits = 0
    this.misses = 0
  }

  /** Hit / miss counters for telemetry + tests. */
  getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }

  /**
   * Strip volatile fields from a BrainDecision before caching. raw LLM
   * output and token counts are run-specific telemetry, not part of the
   * decision; replaying them on a cache hit would lie about what just
   * happened.
   */
  private stripVolatile(decision: BrainDecision): BrainDecision {
    return {
      ...decision,
      raw: '[cached]',
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    }
  }
}
