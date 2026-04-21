/**
 * Gen 33 — fan-out executor.
 *
 * Pure-function tests for formatFeedback + concurrency cap. The
 * end-to-end spawning path is covered by integration tests under
 * tests/playwright-driver-*.test.ts that exercise the real runner.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  formatFeedback,
  resolveSubGoals,
  resolveFanOutConcurrency,
  resolveFanOutStaggerMs,
  runPool,
  FAN_OUT_MAX_CONCURRENT,
  type FanOutBranchResult,
} from '../src/runner/fan-out.js'
import type { FanOutAction } from '../src/types.js'

function branch(overrides: Partial<FanOutBranchResult> = {}): FanOutBranchResult {
  return {
    index: 0,
    label: 'branch-1',
    url: 'https://example.com/',
    goal: 'do the thing',
    success: true,
    verdict: 'success verdict',
    turnsUsed: 3,
    durationMs: 1200,
    ...overrides,
  }
}

describe('formatFeedback', () => {
  it('header reports N branches', () => {
    const out = formatFeedback([branch(), branch({ index: 1, label: 'branch-2' })])
    expect(out).toContain('FAN-OUT RESULTS (2 branches)')
  })

  it('emits JSON payload of all branches', () => {
    const out = formatFeedback([
      branch({ label: 'A', verdict: 'verdict A' }),
      branch({ label: 'B', verdict: 'verdict B', index: 1 }),
    ])
    // Extract the JSON block and parse it
    const match = out.match(/```json\n([\s\S]*?)\n```/)
    expect(match).toBeTruthy()
    const parsed = JSON.parse(match![1])
    expect(parsed).toHaveLength(2)
    expect(parsed[0].label).toBe('A')
    expect(parsed[0].verdict).toBe('verdict A')
    expect(parsed[1].label).toBe('B')
  })

  it('uses ✓ / ✗ status icons per branch', () => {
    const out = formatFeedback([
      branch({ label: 'ok', success: true }),
      branch({ label: 'fail', success: false, index: 1 }),
    ])
    expect(out).toContain('[✓] ok')
    expect(out).toContain('[✗] fail')
  })

  it('includes summarize hint when provided', () => {
    const out = formatFeedback([branch()], 'merge into a single verdict per customer')
    expect(out).toContain('SUMMARIZATION HINT: merge into a single verdict per customer')
  })

  it('truncates long verdicts in the summary line but keeps them in JSON', () => {
    const long = 'x'.repeat(500)
    const out = formatFeedback([branch({ verdict: long })])
    // Summary line is truncated to ~200 chars
    const lines = out.split('\n')
    const summaryLine = lines.find((l) => l.includes('[✓]') && l.includes('branch-1'))!
    expect(summaryLine.length).toBeLessThan(260)
    // But the JSON payload carries the full verdict
    const jsonBlock = out.match(/```json\n([\s\S]*?)\n```/)![1]
    const parsed = JSON.parse(jsonBlock)
    expect(parsed[0].verdict).toBe(long)
  })

  it('collapses whitespace in summary lines (no multi-line explosions)', () => {
    const out = formatFeedback([branch({ verdict: 'line 1\nline 2\nline 3' })])
    const lines = out.split('\n')
    const summaryLine = lines.find((l) => l.includes('[✓]') && l.includes('branch-1'))!
    expect(summaryLine).not.toContain('\n')
    expect(summaryLine).toContain('line 1 line 2 line 3')
  })

  it('handles the empty-branches case gracefully', () => {
    const out = formatFeedback([])
    expect(out).toContain('FAN-OUT RESULTS (0 branches)')
  })
})

describe('FAN_OUT_MAX_CONCURRENT', () => {
  it('is 8 — pins the runaway-spawn safety cap', () => {
    // Changing this number is a product decision, not an incidental
    // refactor. Pin it with a test so a later "just bump it" lands
    // as an explicit change in the review.
    expect(FAN_OUT_MAX_CONCURRENT).toBe(8)
  })
})

describe('resolveSubGoals — LLM-friendly shorthand', () => {
  const a = (overrides: Partial<FanOutAction>): FanOutAction => ({
    action: 'fanOut',
    ...overrides,
  })

  it('passes explicit subGoals through unchanged when present', () => {
    const explicit = [
      { url: 'https://a.test/', goal: 'do A', label: 'A' },
      { url: 'https://b.test/', goal: 'do B', label: 'B' },
    ]
    expect(resolveSubGoals(a({ subGoals: explicit }))).toBe(explicit)
  })

  it('expands baseUrl + goalTemplate + items → full subGoals', () => {
    const expanded = resolveSubGoals(a({
      baseUrl: 'https://sanctionssearch.ofac.treas.gov/',
      goalTemplate: 'Screen {item} on OFAC SDN. Report disposition.',
      items: ['SMITH JOHN', 'MADURO NICOLAS', 'AL-ASSAD BASHAR'],
    }))
    expect(expanded).toHaveLength(3)
    expect(expanded![0]).toEqual({
      url: 'https://sanctionssearch.ofac.treas.gov/',
      goal: 'Screen SMITH JOHN on OFAC SDN. Report disposition.',
      label: 'SMITH JOHN',
    })
    expect(expanded![2].label).toBe('AL-ASSAD BASHAR')
  })

  it('replaces all {item} occurrences in the template', () => {
    const expanded = resolveSubGoals(a({
      baseUrl: 'https://x/',
      goalTemplate: 'Find {item}. Report {item} disposition.',
      items: ['X'],
    }))
    expect(expanded![0].goal).toBe('Find X. Report X disposition.')
  })

  it('returns undefined when neither explicit subGoals nor shorthand is complete', () => {
    expect(resolveSubGoals(a({}))).toBeUndefined()
    expect(resolveSubGoals(a({ baseUrl: 'x', goalTemplate: 'y' }))).toBeUndefined()
    expect(resolveSubGoals(a({ baseUrl: 'x', items: ['y'] }))).toBeUndefined()
    expect(resolveSubGoals(a({ goalTemplate: 't', items: ['i'] }))).toBeUndefined()
  })

  it('returns undefined when items is empty', () => {
    expect(resolveSubGoals(a({ baseUrl: 'x', goalTemplate: 't', items: [] }))).toBeUndefined()
  })

  it('explicit subGoals take precedence if both forms are set', () => {
    const explicit = [{ url: 'https://a.test/', goal: 'X', label: 'A' }]
    const out = resolveSubGoals(a({
      subGoals: explicit,
      baseUrl: 'x', goalTemplate: 'y', items: ['z'],
    }))
    expect(out).toBe(explicit)
  })
})

describe('resolveFanOutConcurrency — env knob for throttled targets', () => {
  const save = process.env.BAD_FANOUT_CONCURRENCY
  afterEach(() => {
    if (save === undefined) delete process.env.BAD_FANOUT_CONCURRENCY
    else process.env.BAD_FANOUT_CONCURRENCY = save
  })

  it('defaults to the hard cap (8) when unset', () => {
    delete process.env.BAD_FANOUT_CONCURRENCY
    expect(resolveFanOutConcurrency()).toBe(8)
  })

  it('accepts values in [1, 8]', () => {
    process.env.BAD_FANOUT_CONCURRENCY = '2'
    expect(resolveFanOutConcurrency()).toBe(2)
    process.env.BAD_FANOUT_CONCURRENCY = '1'
    expect(resolveFanOutConcurrency()).toBe(1)
  })

  it('clamps below 1 to 1 and above 8 to 8', () => {
    process.env.BAD_FANOUT_CONCURRENCY = '0'
    expect(resolveFanOutConcurrency()).toBe(1)
    process.env.BAD_FANOUT_CONCURRENCY = '-5'
    expect(resolveFanOutConcurrency()).toBe(1)
    process.env.BAD_FANOUT_CONCURRENCY = '100'
    expect(resolveFanOutConcurrency()).toBe(8)
  })

  it('falls back to cap on garbage input', () => {
    process.env.BAD_FANOUT_CONCURRENCY = 'banana'
    expect(resolveFanOutConcurrency()).toBe(1)
  })
})

describe('resolveFanOutStaggerMs — spacing between sub-agent launches', () => {
  const save = process.env.BAD_FANOUT_STAGGER_MS
  afterEach(() => {
    if (save === undefined) delete process.env.BAD_FANOUT_STAGGER_MS
    else process.env.BAD_FANOUT_STAGGER_MS = save
  })

  it('defaults to 0 (no stagger)', () => {
    delete process.env.BAD_FANOUT_STAGGER_MS
    expect(resolveFanOutStaggerMs()).toBe(0)
  })

  it('accepts positive integers', () => {
    process.env.BAD_FANOUT_STAGGER_MS = '30000'
    expect(resolveFanOutStaggerMs()).toBe(30000)
  })

  it('rejects negatives and garbage', () => {
    process.env.BAD_FANOUT_STAGGER_MS = '-1'
    expect(resolveFanOutStaggerMs()).toBe(0)
    process.env.BAD_FANOUT_STAGGER_MS = 'tomorrow'
    expect(resolveFanOutStaggerMs()).toBe(0)
  })
})

describe('runPool — bounded concurrency + stagger', () => {
  it('processes every item and returns results in input order', async () => {
    const out = await runPool([1, 2, 3, 4, 5], 2, 0, async (n) => n * 2)
    expect(out).toEqual([2, 4, 6, 8, 10])
  })

  it('respects the concurrency cap (never more than N in flight)', async () => {
    let inFlight = 0
    let peak = 0
    const out = await runPool([0, 0, 0, 0, 0, 0, 0, 0], 3, 0, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      return 1
    })
    expect(out).toHaveLength(8)
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('staggers subsequent launches so starts are spaced by ≥ staggerMs', async () => {
    const starts: number[] = []
    const t0 = Date.now()
    await runPool([0, 0, 0], 3, 30, async () => {
      starts.push(Date.now() - t0)
      await new Promise((r) => setTimeout(r, 5))
      return 1
    })
    // starts[0] ≈ 0, starts[1] ≈ 30, starts[2] ≈ 60 (±scheduling slop)
    expect(starts[0]!).toBeLessThan(15)
    expect(starts[1]!).toBeGreaterThanOrEqual(25)
    expect(starts[2]!).toBeGreaterThanOrEqual(55)
  })

  it('returns an empty array for empty input without calling the worker', async () => {
    let calls = 0
    const out = await runPool([], 4, 100, async () => {
      calls++
      return 1
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it('surfaces thrown errors rather than swallowing them', async () => {
    await expect(
      runPool([1, 2], 2, 0, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})
