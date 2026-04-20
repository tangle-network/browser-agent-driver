/**
 * Gen 33 — fan-out executor.
 *
 * Pure-function tests for formatFeedback + concurrency cap. The
 * end-to-end spawning path is covered by integration tests under
 * tests/playwright-driver-*.test.ts that exercise the real runner.
 */
import { describe, it, expect } from 'vitest'
import {
  formatFeedback,
  FAN_OUT_MAX_CONCURRENT,
  type FanOutBranchResult,
} from '../src/runner/fan-out.js'

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
