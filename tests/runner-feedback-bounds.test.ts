/**
 * Wave-1 history/feedback bounds:
 *   1. capFeedbackText bounds injectFeedback payloads (extraction results
 *      re-bill as input tokens on every later turn if fed back uncapped).
 *   2. decide() sends "NO CHANGES — refs still valid" instead of the full
 *      snapshot when the structured diff shows zero changes.
 */

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { capFeedbackText } from '../src/runner/utils.js'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types/page.js'

describe('capFeedbackText', () => {
  it('leaves short payloads untouched', () => {
    expect(capFeedbackText('SCRIPT RESULT:\n{"a": 1}')).toBe('SCRIPT RESULT:\n{"a": 1}')
  })

  it('caps long payloads at 1000 chars with a truncation marker', () => {
    const blob = 'SCRIPT RESULT:\n' + 'x'.repeat(50_000)
    const capped = capFeedbackText(blob)
    expect(capped.startsWith('SCRIPT RESULT:\n' + 'x'.repeat(985))).toBe(true)
    expect(capped.length).toBeLessThan(1100)
    expect(capped).toContain('chars truncated')
  })

  it('honors a custom cap', () => {
    expect(capFeedbackText('abcdef', 3)).toContain('abc')
    expect(capFeedbackText('abcdef', 3)).toContain('3 chars truncated')
  })
})

describe('decide zero-diff snapshot suppression', () => {
  const state: PageState = {
    url: 'https://example.com/form',
    title: 'Form',
    snapshot: '- textbox "Email" [ref=t1]\n- button "Next" [ref=b2]',
    snapshotDiffRaw: { added: [], removed: [], changed: [], unchangedCount: 2 },
  } as PageState

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

  it('same-page turn with zero diff changes sends NO CHANGES, not the snapshot', async () => {
    const { brain, captured } = brainWithCapture()
    // Turn 1 establishes lastDecisionUrl (first turn never diffs).
    await brain.decide('goal', state, undefined, { current: 1, max: 8 })
    // Turn 2: same URL, zero-change diff.
    await brain.decide('goal', state, undefined, { current: 2, max: 8 })
    const text = lastUserText(captured[1].messages)
    expect(text).toContain('NO CHANGES since last turn')
    expect(text).not.toContain('- textbox "Email"')
  })

  it('first turn on a page still sends the full snapshot', async () => {
    const { brain, captured } = brainWithCapture()
    await brain.decide('goal', state, undefined, { current: 1, max: 8 })
    expect(lastUserText(captured[0].messages)).toContain('- textbox "Email"')
  })
})
