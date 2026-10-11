/**
 * Wave-1 output-truncation fixes:
 *   1. Google generation options zero the Gemini thinking budget on flash
 *      models (hidden thinking tokens consumed the 600-token output cap
 *      before the JSON body, truncating responses mid-object).
 *   2. The decide prompt's RESPONSE FORMAT schema and examples emit
 *      "action" FIRST so a truncated response still contains the action.
 */

import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain/index.js'
import { CORE_RULES, REASONING_SUFFIX } from '../src/brain/prompts.js'

function googleBrain() {
  return new Brain({
    provider: 'google',
    model: 'gemini-2.5-flash',
    apiKey: 'sk-test-mock',
    vision: false,
  })
}

describe('Google generation options (thinking budget)', () => {
  it('zeroes thinkingBudget for gemini flash models', () => {
    const brain = googleBrain()
    // generationOptions is private; reach in for the test (same pattern as
    // tests/brain-proxy.integration.test.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (brain as any).generationOptions(2000, { provider: 'google', model: 'gemini-2.5-flash' })
    expect(opts.providerOptions?.google?.thinkingConfig?.thinkingBudget).toBe(0)
  })

  it('does NOT set thinkingBudget for gemini pro models (API rejects 0)', () => {
    const brain = googleBrain()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (brain as any).generationOptions(2000, { provider: 'google', model: 'gemini-2.5-pro' })
    expect(opts.providerOptions?.google?.thinkingConfig?.thinkingBudget).toBeUndefined()
  })

  it('does NOT set google providerOptions for other providers', () => {
    const brain = googleBrain()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (brain as any).generationOptions(800, { provider: 'openai', model: 'gpt-4o' })
    expect(opts.providerOptions?.google).toBeUndefined()
  })
})

describe('decide prompt schema order (action first)', () => {
  it('RESPONSE FORMAT shows "action" before "plan"', () => {
    const fmtStart = CORE_RULES.indexOf('RESPONSE FORMAT')
    expect(fmtStart).toBeGreaterThan(-1)
    const fmt = CORE_RULES.slice(fmtStart)
    expect(fmt.indexOf('"action"')).toBeLessThan(fmt.indexOf('"plan"'))
  })

  it('every REASONING_SUFFIX example emits "action" first', () => {
    const examples = REASONING_SUFFIX.split('EXAMPLE').slice(1)
    expect(examples.length).toBeGreaterThanOrEqual(3)
    for (const ex of examples) {
      const jsonStart = ex.indexOf('{')
      expect(jsonStart).toBeGreaterThan(-1)
      const body = ex.slice(jsonStart)
      expect(body.indexOf('"action"')).toBeLessThan(body.indexOf('"plan"'))
    }
  })
})
