/**
 * Wave-2 prefix-stable history:
 *   materializeHistoryPrefix() replaces per-turn in-place rewrites with an
 *   append-only summary block + untouched tail. The provider's implicit
 *   prefix cache only hits on byte-stable prefixes — these tests pin that
 *   (a) prior messages are never re-edited, (b) the summary materializes
 *   once per overflow and then only grows by appending.
 */

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { buildSystemPromptImpl, type BrainSystemPromptHost } from '../src/brain/system-prompt.js'
import { SYSTEM_PROMPT } from '../src/brain/prompts.js'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types/page.js'
import {
  HISTORY_TAIL_MESSAGES,
  materializeHistoryPrefix,
  type MaterializingHistoryHost,
} from '../src/brain/history-compact.js'

function pair(n: number): ModelMessage[] {
  return [
    { role: 'user', content: `GOAL: g\n\nURL: https://example.com/${n}\nTitle: Page ${n}\n\nELEMENTS:\n- button "B${n}" [ref=b${n}]` },
    { role: 'assistant', content: `{"action":{"action":"click","selector":"@b${n}"}}` },
  ]
}

function hostWith(turns: number): MaterializingHistoryHost {
  const history: ModelMessage[] = []
  for (let i = 1; i <= turns; i++) history.push(...pair(i))
  return { history, historySummary: '' }
}

describe('materializeHistoryPrefix', () => {
  it('passes history through untouched while under the tail cap', () => {
    const host = hostWith(2) // 4 messages < 8
    const before = [...host.history]
    const out = materializeHistoryPrefix(host)
    expect(host.historySummary).toBe('')
    expect(out).toEqual(before)
  })

  it('materializes the oldest messages into an append-only summary on overflow', () => {
    const host = hostWith(5) // 10 messages > 8 → summarize oldest 2
    const out = materializeHistoryPrefix(host)
    expect(host.history).toHaveLength(HISTORY_TAIL_MESSAGES)
    expect(host.historySummary).toContain('URL: https://example.com/1')
    expect(out[0].role).toBe('user')
    expect(String(out[0].content)).toContain('PRIOR TURNS (compacted')
    expect(String(out[0].content)).toContain(host.historySummary)
  })

  it('never re-edits prior content: messages are append-only between materializations', () => {
    const host = hostWith(5)
    const snapshots: string[][] = []
    // Simulate 6 turns of appends + materialization.
    for (let turn = 6; turn <= 11; turn++) {
      const messages = materializeHistoryPrefix(host)
      snapshots.push(messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`))
      host.history.push(...pair(turn))
    }
    // Between consecutive turns, every message that existed before must be
    // IDENTICAL at the same position — except the single summary slot at
    // index 0, which may only change by appending lines.
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1]
      const next = snapshots[i]
      // The summary slot either stays byte-identical or grows by appending.
      if (prev[0].startsWith('user:PRIOR TURNS') && next[0].startsWith('user:PRIOR TURNS')) {
        expect(next[0] === prev[0] || next[0].startsWith(prev[0])).toBe(true)
      }
      // The non-summary prefix is byte-stable: the previous list is a
      // strict prefix of the next, except when a materialization dropped
      // tail messages (then the summary grew — checked above).
      const prevTail = prev[0].startsWith('user:PRIOR TURNS') ? prev.slice(1) : prev
      const nextTail = next[0].startsWith('user:PRIOR TURNS') ? next.slice(1) : next
      if (next[0] === prev[0]) {
        // No materialization happened: tail is append-only.
        expect(nextTail.slice(0, prevTail.length)).toEqual(prevTail)
      }
    }
  })

  it('summary survives multiple materializations and keeps oldest context', () => {
    const host = hostWith(5)
    materializeHistoryPrefix(host)
    for (let turn = 6; turn <= 10; turn++) host.history.push(...pair(turn))
    materializeHistoryPrefix(host)
    expect(host.historySummary).toContain('URL: https://example.com/1')
    expect(host.historySummary).toContain('URL: https://example.com/3')
    expect(host.history.length).toBeLessThanOrEqual(HISTORY_TAIL_MESSAGES)
  })
})

// ── system prompt byte-stability across turns ───────────────────────────

describe('buildSystemPrompt turn stability (prefix cache: system message must be byte-stable)', () => {
  function hostFor(state: PageState): BrainSystemPromptHost {
    return { systemPrompt: SYSTEM_PROMPT } as unknown as BrainSystemPromptHost
  }
  const smallState = { url: 'https://example.com', title: 't', snapshot: '- link "a" [ref=l1]' } as PageState

  it('is byte-identical at turn 5 and turn 12 for the same page', () => {
    const host = hostFor(smallState)
    expect(buildSystemPromptImpl(host, 'goal', smallState, 5)).toBe(buildSystemPromptImpl(host, 'goal', smallState, 12))
  })
})


describe('run-frozen system prompt (wave 3)', () => {
  function freshBrain(): Brain {
    return new Brain({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'sk-test', vision: false })
  }
  const searchPage = { url: 'https://news.ycombinator.com/', title: 'HN', snapshot: '- searchbox "Search" [ref=s1]\n- link "x" [ref=l1]' } as PageState
  const plainPage = { url: 'https://example.com/about', title: 'About', snapshot: '- link "y" [ref=l2]' } as PageState

  it('is byte-identical across pages with different conditional rule groups', () => {
    const brain = freshBrain()
    const first = brain.buildSystemForDecide('goal', searchPage, 1, 'google')
    const second = brain.buildSystemForDecide('goal', plainPage, 3, 'google')
    expect(second).toBe(first)
  })

  it('reset() unfreezes so the next run recomputes', () => {
    const brain = freshBrain()
    const first = brain.buildSystemForDecide('goal', searchPage, 1, 'google')
    brain.reset()
    const second = brain.buildSystemForDecide('goal', plainPage, 1, 'google')
    expect(second).not.toBe(first)
  })
})
