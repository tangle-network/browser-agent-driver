/**
 * Tests for the Gen 6 batch action verbs (fill, clickSequence) — pin the
 * JSON parser, the validateAction shape, and the supervisor signature.
 *
 * The driver's actual `fill` execution is covered by an integration test in
 * tests/playwright-driver-batch.test.ts which spins up a real Chromium page.
 */

import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain/index.js'
import type { Action } from '../src/types.js'

type BrainParse = (raw: string) => { action: Action; reasoning?: string }

function parseJson(json: string): { action: Action; reasoning?: string } {
  const brain = new Brain()
  const fn = (brain as unknown as { parse: BrainParse }).parse
  return fn.call(brain, json) as { action: Action; reasoning?: string }
}

describe('Brain.parse — fill action', () => {
  it('parses a fill with only fields', () => {
    const json = JSON.stringify({
      action: { action: 'fill', fields: { '@t1': 'Jordan', '@t2': 'Rivera' } },
      reasoning: 'batch fill',
    })
    const { action } = parseJson(json)
    expect(action.action).toBe('fill')
    if (action.action !== 'fill') throw new Error('narrow')
    expect(action.fields).toEqual({ '@t1': 'Jordan', '@t2': 'Rivera' })
    expect(action.selects).toBeUndefined()
    expect(action.checks).toBeUndefined()
  })

  it('parses a fill with fields + selects + checks', () => {
    const json = JSON.stringify({
      action: {
        action: 'fill',
        fields: { '@t1': 'a' },
        selects: { '@s1': 'WA' },
        checks: ['@c1', '@c2'],
      },
    })
    const { action } = parseJson(json)
    if (action.action !== 'fill') throw new Error('narrow')
    expect(action.fields).toEqual({ '@t1': 'a' })
    expect(action.selects).toEqual({ '@s1': 'WA' })
    expect(action.checks).toEqual(['@c1', '@c2'])
  })

  it('parses a fill with only checks', () => {
    const json = JSON.stringify({
      action: { action: 'fill', checks: ['@c1', '@c2', '@c3'] },
    })
    const { action } = parseJson(json)
    if (action.action !== 'fill') throw new Error('narrow')
    expect(action.checks).toEqual(['@c1', '@c2', '@c3'])
  })

  it('rejects an empty fill (no fields/selects/checks)', () => {
    const json = JSON.stringify({ action: { action: 'fill' } })
    const { action, reasoning } = parseJson(json)
    // Parser falls back to wait+reasoning on validation errors
    expect(action.action).toBe('wait')
    expect(reasoning).toMatch(/Malformed LLM JSON response/)
  })

  it('rejects fields with non-string values', () => {
    const json = JSON.stringify({ action: { action: 'fill', fields: { '@t1': 42 } } })
    const { action } = parseJson(json)
    // Non-string field value → not a Record<string,string> → fields treated as undefined → empty fill → error
    expect(action.action).toBe('wait')
  })
})

describe('Brain.parse — clickSequence action', () => {
  it('parses a clickSequence with refs', () => {
    const json = JSON.stringify({
      action: { action: 'clickSequence', refs: ['@b1', '@b2', '@b3'] },
    })
    const { action } = parseJson(json)
    if (action.action !== 'clickSequence') throw new Error('narrow')
    expect(action.refs).toEqual(['@b1', '@b2', '@b3'])
    expect(action.intervalMs).toBeUndefined()
  })

  it('parses a clickSequence with custom intervalMs', () => {
    const json = JSON.stringify({
      action: { action: 'clickSequence', refs: ['@b1'], intervalMs: 250 },
    })
    const { action } = parseJson(json)
    if (action.action !== 'clickSequence') throw new Error('narrow')
    expect(action.intervalMs).toBe(250)
  })

  it('rejects an empty refs array', () => {
    const json = JSON.stringify({ action: { action: 'clickSequence', refs: [] } })
    const { action } = parseJson(json)
    expect(action.action).toBe('wait')
  })

  it('rejects refs with non-string entries', () => {
    const json = JSON.stringify({ action: { action: 'clickSequence', refs: ['@b1', 42] } })
    const { action } = parseJson(json)
    expect(action.action).toBe('wait')
  })
})

describe('Brain.parse — both actions in VALID_ACTIONS', () => {
  it('does not throw "Unknown action" for fill or clickSequence', () => {
    expect(() => parseJson(JSON.stringify({ action: { action: 'fill', fields: { '@a': 'x' } } }))).not.toThrow()
    expect(() => parseJson(JSON.stringify({ action: { action: 'clickSequence', refs: ['@a'] } }))).not.toThrow()
  })
})
