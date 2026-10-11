/**
 * Wave-1 final-turn guarantees:
 *   1. synthesizeFinalTurnCompletion — on the final turn, a non-terminal
 *      action with script evidence on the ledger auto-completes from that
 *      evidence (both lost hn reps in the 2026-10-11 bench died at max
 *      turns with the answer already extracted).
 *   2. decide() swaps the open-ended "What action should you take?" for a
 *      terminal-only schema on the final turn.
 */

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { synthesizeFinalTurnCompletion } from '../src/runner/completion-policy.js'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types/page.js'

describe('synthesizeFinalTurnCompletion', () => {
  const scriptEvidence = ['SCRIPT RESULT:\n{"score": 247, "comments": 89}']

  it('synthesizes complete from script evidence on the final turn', () => {
    const out = synthesizeFinalTurnCompletion(
      { action: 'runScript', script: '1+1' },
      scriptEvidence,
      true,
    )
    expect(out.synthesized).toBe(true)
    expect(out.action).toEqual({
      action: 'complete',
      result: '{"score": 247, "comments": 89}',
    })
  })

  it('leaves non-final-turn actions untouched even with evidence', () => {
    const action = { action: 'runScript', script: '1+1' }
    const out = synthesizeFinalTurnCompletion(action, scriptEvidence, false)
    expect(out.synthesized).toBe(false)
    expect(out.action).toBe(action)
  })

  it('leaves terminal actions untouched', () => {
    const action = { action: 'complete', result: 'done' }
    const out = synthesizeFinalTurnCompletion(action, scriptEvidence, true)
    expect(out.synthesized).toBe(false)
    expect(out.action).toBe(action)
  })

  it('does not synthesize without script evidence', () => {
    const action = { action: 'navigate', url: 'https://x' }
    const out = synthesizeFinalTurnCompletion(action, ['EXTRACT RESULT (2 matches):\nsome text'], true)
    expect(out.synthesized).toBe(false)
    expect(out.action).toBe(action)
  })

  it('does not synthesize from a meaningless script result', () => {
    const action = { action: 'runScript', script: '1+1' }
    for (const empty of ['SCRIPT RESULT:\nnull', 'SCRIPT RESULT:\n', 'SCRIPT RESULT:\n{}']) {
      const out = synthesizeFinalTurnCompletion(action, [empty], true)
      expect(out.synthesized).toBe(false)
      expect(out.action).toBe(action)
    }
  })

  it('uses the most RECENT script result', () => {
    const action = { action: 'runScript', script: '1+1' }
    const out = synthesizeFinalTurnCompletion(
      action,
      ['SCRIPT RESULT:\nfirst', 'SCRIPT RESULT:\nsecond'],
      true,
    )
    expect(out.synthesized).toBe(true)
    expect(out.action).toEqual({ action: 'complete', result: 'second' })
  })
})

describe('decide final-turn terminal-only schema', () => {
  const state: PageState = { url: 'https://example.com', title: 't', snapshot: '- link "a" [ref=l1]' } as PageState

  function brainWithCapture() {
    const brain = new Brain({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'sk-test', vision: false })
    const captured: { messages: ModelMessage[] }[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(brain as any).generate = async (_system: unknown, messages: ModelMessage[]) => {
      captured.push({ messages })
      return { text: '{"action":{"action":"wait","ms":1000},"reasoning":"r","expectedEffect":"e","currentStep":0,"plan":["x"]}' }
    }
    return { brain, captured }
  }

  function lastUserText(messages: ModelMessage[]): string {
    const last = messages[messages.length - 1]
    return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
  }

  it('final turn asks for a terminal action only', async () => {
    const { brain, captured } = brainWithCapture()
    await brain.decide('goal', state, undefined, { current: 7, max: 8 })
    const text = lastUserText(captured[0].messages)
    expect(text).toContain('FINAL TURN — respond with ONLY a terminal action')
    expect(text).not.toContain('What action should you take?')
  })

  it('very last turn (remaining 0) is also terminal-only', async () => {
    const { brain, captured } = brainWithCapture()
    await brain.decide('goal', state, undefined, { current: 8, max: 8 })
    expect(lastUserText(captured[0].messages)).toContain('FINAL TURN — respond with ONLY a terminal action')
  })

  it('non-final turn keeps the open-ended question', async () => {
    const { brain, captured } = brainWithCapture()
    await brain.decide('goal', state, undefined, { current: 3, max: 8 })
    const text = lastUserText(captured[0].messages)
    expect(text).toContain('What action should you take?')
    expect(text).not.toContain('FINAL TURN — respond with ONLY a terminal action')
  })
})
