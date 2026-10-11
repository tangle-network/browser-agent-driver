/**
 * Wave-1 history/feedback bounds:
 *   1. capFeedbackText bounds injectFeedback payloads (extraction results
 *      re-bill as input tokens on every later turn if fed back uncapped).
 *   2. Regression guard: zero-diff same-page turns must STILL send the
 *      snapshot — form fills don't alter the a11y tree, so a "NO CHANGES"
 *      stub made the model conclude the page was broken and abort.
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

describe('decide zero-diff turns keep the snapshot', () => {
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

  it('same-page turn with zero diff changes STILL sends the snapshot', async () => {
    const { brain, captured } = brainWithCapture()
    // Turn 1 establishes lastDecisionUrl (first turn never diffs).
    await brain.decide('goal', state, undefined, { current: 1, max: 8 })
    // Turn 2: same URL, zero-change diff. Form fills do not alter the a11y
    // tree, so suppressing the snapshot here made the model conclude the
    // page was broken and abort (bench wave 1 regression).
    await brain.decide('goal', state, undefined, { current: 2, max: 8 })
    const text = lastUserText(captured[1].messages)
    expect(text).toContain('- textbox "Email"')
    expect(text).not.toContain('NO CHANGES since last turn')
  })

  it('first turn on a page still sends the full snapshot', async () => {
    const { brain, captured } = brainWithCapture()
    await brain.decide('goal', state, undefined, { current: 1, max: 8 })
    expect(lastUserText(captured[0].messages)).toContain('- textbox "Email"')
  })
})

describe('new-page snapshot budget (wave 5)', () => {
  const bigState: PageState = {
    url: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    title: 'Ada',
    snapshot: '- heading "Ada Lovelace" [ref=h1]\n' + '- code "int x = 1;"\n'.repeat(1500),
  } as PageState

  it('new-page turns serve at most ~12k chars of snapshot with a windowing hint', async () => {
    const brain = new Brain({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'sk-test', vision: false })
    const captured: ModelMessage[][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(brain as any).generate = async (_s: unknown, messages: ModelMessage[]) => {
      captured.push(messages)
      return { text: '{"action":{"action":"wait","ms":1000},"reasoning":"r","expectedEffect":"e","currentStep":0,"plan":["x"]}' }
    }
    await brain.decide('goal', bigState, undefined, { current: 1, max: 8 })
    const text = String(captured[0][captured[0].length - 1].content)
    expect(text).toContain('ELEMENTS (windowed')
    expect(text).toContain('extractWithIndex')
    const elementsBlock = text.split('ELEMENTS (windowed')[1] ?? ''
    expect(elementsBlock.length).toBeLessThan(13_000)
  })
})
