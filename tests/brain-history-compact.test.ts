import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { compactHistory } from '../src/brain/history-compact.js'

/**
 * Guard for the 3-zone history compaction extracted from Brain.
 *
 * With 14 messages (7 user/assistant pairs), the zone boundaries are:
 *   - keepIntactFrom = index of the 2nd-to-last user message = 10
 *   - deepCompactBefore = max(0, 14 - 10) = 4
 * So:
 *   - Zone 3 (deep compact):  idx 0..3   — user → "[Prior turn …]", assistant → "[action → selector]"
 *   - Zone 2 (standard):      idx 4..9   — user ELEMENTS blocks summarized, paired assistant supplies selectors
 *   - Zone 1 (intact):        idx 10..13 — untouched
 */

const ELEMENTS_USER = `GOAL: test

ELEMENTS:
- button "Go" [ref=b1]
- link "Home" [ref=l2]

What action should you take?`

const INTACT_USER = `GOAL: test

ELEMENTS:
- button "Recent" [ref=z1]

What action should you take?`

function buildHistory(): ModelMessage[] {
  return [
    // Zone 3 — deep compact
    { role: 'user', content: 'URL: https://old.example/page\nTitle: Old Page Title' },
    { role: 'assistant', content: '{"action":{"action":"click","selector":"@old1"}}' },
    { role: 'user', content: 'URL: https://old.example/two\nTitle: Second' },
    { role: 'assistant', content: '{"action":{"action":"navigate","url":"https://old.example/two"}}' },
    // Zone 2 — standard compact
    { role: 'user', content: ELEMENTS_USER },
    { role: 'assistant', content: '{"action":{"action":"click","selector":"@b1"},"nextActions":[{"action":"type","selector":"@l2","text":"x"}]}' },
    { role: 'user', content: 'No elements block here — plain follow-up text.' },
    { role: 'assistant', content: '{"action":{"action":"wait","ms":500}}' },
    { role: 'user', content: 'URL: https://mid.example\nTitle: Mid' },
    { role: 'assistant', content: '{"action":{"action":"scroll","direction":"down"}}' },
    // Zone 1 — intact (last 2 user messages onward)
    { role: 'user', content: INTACT_USER },
    { role: 'assistant', content: '{"action":{"action":"click","selector":"@z1"}}' },
    { role: 'user', content: 'Final user turn — kept verbatim.' },
    { role: 'assistant', content: '{"action":{"action":"complete","result":"done"}}' },
  ]
}

describe('compactHistory — 3-zone compaction', () => {
  it('returns [] for empty history', () => {
    expect(compactHistory([])).toEqual([])
  })

  it('preserves message count', () => {
    const out = compactHistory(buildHistory())
    expect(out).toHaveLength(14)
  })

  it('Zone 3: deep-compacts old user messages to a URL/title stub', () => {
    const out = compactHistory(buildHistory())
    expect(out[0].content).toBe('[Prior turn — URL: https://old.example/page | Old Page Title]')
  })

  it('Zone 3: deep-compacts old assistant messages to an action stub', () => {
    const out = compactHistory(buildHistory())
    expect(out[1].content).toBe('[click → @old1]')
  })

  it('Zone 2: summarizes the ELEMENTS block and lists the selectors the agent used', () => {
    const out = compactHistory(buildHistory())
    expect(out[4].content).toContain('ELEMENTS:\n[Page snapshot: 2 elements | agent used: @b1, @l2]')
    // The raw refs must be gone — that's the token saving.
    expect(out[4].content).not.toContain('[ref=b1]')
    expect(out[4].content).not.toContain('[ref=l2]')
  })

  it('Zone 2: leaves user messages with no ELEMENTS block unchanged', () => {
    const history = buildHistory()
    const out = compactHistory(history)
    expect(out[6].content).toBe(history[6].content)
  })

  it('Zone 1: keeps the last two turns fully intact, ELEMENTS and all', () => {
    const history = buildHistory()
    const out = compactHistory(history)
    expect(out[10].content).toBe(history[10].content)
    expect(out[10].content).toContain('[ref=z1]')
    expect(out[12].content).toBe(history[12].content)
    expect(out[13].content).toBe(history[13].content)
  })
})
