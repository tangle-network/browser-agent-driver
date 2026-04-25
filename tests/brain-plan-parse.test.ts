/**
 * Tests for Brain.plan() — the Gen 7 single-LLM-call planner.
 *
 * The actual LLM call requires an API key, so these tests stub the
 * `generate` private method to return canned plan JSON. We're testing
 * the parser, validator, and the contract for null returns on bad input.
 *
 * The end-to-end planner verification (against a real LLM + real
 * Chromium) lives in the long-form benchmark — see
 * .evolve/pursuits/2026-04-08-plan-then-execute-gen7.md.
 */

import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'

const STATE: PageState = {
  url: 'https://example.com/form',
  title: 'Form',
  snapshot: `
- form "signup":
  - textbox "First name" [ref=t1]
  - textbox "Last name" [ref=t2]
  - textbox "Email" [ref=t3]
  - button "Submit" [ref=b1]
`,
}

type GenerateFn = Brain['generate' & keyof Brain]
interface BrainWithGenerate {
  generate: (...args: unknown[]) => Promise<{
    text: string
    tokensUsed?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }>
}

function stubGenerate(brain: Brain, response: string): void {
  ;(brain as unknown as BrainWithGenerate).generate = async () => ({
    text: response,
    tokensUsed: 1500,
    inputTokens: 1200,
    outputTokens: 300,
  })
}

describe('Brain.plan — happy path', () => {
  it('parses a well-formed plan with multiple steps', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      JSON.stringify({
        reasoning: 'Fill the 3 visible text fields then submit',
        steps: [
          {
            action: { action: 'fill', fields: { '@t1': 'Jordan', '@t2': 'Rivera', '@t3': 'jordan@example.com' } },
            expectedEffect: 'all three text fields populated',
            rationale: 'Batch fill all visible text fields in one turn',
          },
          {
            action: { action: 'click', selector: '@b1' },
            expectedEffect: 'form submitted, success message visible',
            rationale: 'Click the Submit button',
          },
          {
            action: { action: 'complete', result: 'Form submitted' },
            expectedEffect: 'completed',
          },
        ],
        finalResult: 'Form submitted successfully',
      }),
    )

    const result = await brain.plan('Fill out the form and submit it', STATE)
    expect(result.plan).not.toBeNull()
    expect(result.plan?.steps).toHaveLength(3)
    expect(result.plan?.steps[0].action.action).toBe('fill')
    expect(result.plan?.steps[1].action.action).toBe('click')
    expect(result.plan?.steps[2].action.action).toBe('complete')
    expect(result.plan?.finalResult).toBe('Form submitted successfully')
    expect(result.plan?.reasoning).toContain('Fill the 3 visible')
    expect(result.parseError).toBeUndefined()
  })

  it('caps the plan at maxSteps when the LLM emits more', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const manySteps = Array.from({ length: 20 }, (_, i) => ({
      action: { action: 'click', selector: `@step${i}` },
      expectedEffect: `step ${i} clicked`,
    }))
    stubGenerate(brain, JSON.stringify({ steps: manySteps }))

    const result = await brain.plan('do many things', STATE, { maxSteps: 5 })
    expect(result.plan?.steps).toHaveLength(5)
  })

  it('strips markdown code fences from the response', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      '```json\n' +
        JSON.stringify({
          steps: [
            {
              action: { action: 'click', selector: '@b1' },
              expectedEffect: 'clicked',
            },
          ],
        }) +
        '\n```',
    )
    const result = await brain.plan('click', STATE)
    expect(result.plan).not.toBeNull()
    expect(result.plan?.steps).toHaveLength(1)
  })
})

describe('Brain.plan — validation + error handling', () => {
  it('returns null on unparseable JSON', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(brain, 'not json at all')
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
    expect(result.parseError).toBeDefined()
  })

  it('returns null when the plan has zero steps', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(brain, JSON.stringify({ reasoning: 'no plan', steps: [] }))
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
    expect(result.parseError).toContain('zero steps')
  })

  it('returns null when steps is missing entirely', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(brain, JSON.stringify({ reasoning: 'no steps key' }))
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
  })

  it('returns null when a step is missing the action object', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      JSON.stringify({
        steps: [{ expectedEffect: 'something' }],
      }),
    )
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
    expect(result.parseError).toContain('missing action')
  })

  it('returns null when a step has an unknown action type', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      JSON.stringify({
        steps: [
          {
            action: { action: 'teleport', selector: '@b1' },
            expectedEffect: 'magical transit',
          },
        ],
      }),
    )
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
    expect(result.parseError).toContain('Unknown action')
  })

  it('returns null on empty response from LLM', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(brain, '')
    const result = await brain.plan('do thing', STATE)
    expect(result.plan).toBeNull()
    expect(result.parseError).toContain('empty response')
  })

  it('substitutes a default expectedEffect when a step omits it', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      JSON.stringify({
        steps: [
          { action: { action: 'click', selector: '@b1' } }, // no expectedEffect
        ],
      }),
    )
    const result = await brain.plan('click', STATE)
    expect(result.plan?.steps[0].expectedEffect).toBeTruthy()
  })
})

describe('Brain.plan — token usage', () => {
  it('surfaces token counts when present', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    stubGenerate(
      brain,
      JSON.stringify({
        steps: [
          { action: { action: 'click', selector: '@b1' }, expectedEffect: 'clicked' },
        ],
      }),
    )
    const result = await brain.plan('click', STATE)
    expect(result.inputTokens).toBe(1200)
    expect(result.outputTokens).toBe(300)
    expect(result.tokensUsed).toBe(1500)
  })
})

describe('Brain.plan — Gen 7.1 replan extraContext', () => {
  // Capture the user message body that the planner sends to the LLM, so
  // we can verify the deviation context flows through to the prompt.
  function spyGenerate(
    brain: Brain,
    response: string,
  ): { calls: Array<{ system: string; messages: Array<{ role: string; content: string }> }> } {
    const calls: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = []
    ;(brain as unknown as BrainWithGenerate).generate = async (...args: unknown[]) => {
      const [system, messages] = args as [string, Array<{ role: string; content: string }>]
      calls.push({ system, messages })
      return { text: response, tokensUsed: 100, inputTokens: 80, outputTokens: 20 }
    }
    return { calls }
  }

  const VALID_PLAN = JSON.stringify({
    steps: [{ action: { action: 'click', selector: '@b1' }, expectedEffect: 'clicked' }],
  })

  it('omits extraContext from the user prompt when not provided', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const spy = spyGenerate(brain, VALID_PLAN)
    await brain.plan('click submit', STATE)
    expect(spy.calls).toHaveLength(1)
    const userMessage = spy.calls[0].messages[0].content
    expect(userMessage).not.toContain('[REPLAN')
    expect(userMessage).toContain('GOAL: click submit')
  })

  it('injects extraContext into the user prompt when provided', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const spy = spyGenerate(brain, VALID_PLAN)
    const replanContext = '[REPLAN 1/3] The previous plan attempt failed at step 2/3: verification failed at step 2: expected effect not observed\nGenerate a FRESH plan from the current page state.'
    await brain.plan('click submit', STATE, { extraContext: replanContext })
    expect(spy.calls).toHaveLength(1)
    const userMessage = spy.calls[0].messages[0].content
    expect(userMessage).toContain('[REPLAN 1/3]')
    expect(userMessage).toContain('verification failed at step 2')
    expect(userMessage).toContain('GOAL: click submit')
  })

  it('keeps the system prompt byte-stable across replans (cache hit preservation)', async () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const spy = spyGenerate(brain, VALID_PLAN)
    await brain.plan('click submit', STATE)
    await brain.plan('click submit', STATE, { extraContext: '[REPLAN 1/3] failed' })
    await brain.plan('click submit', STATE, { extraContext: '[REPLAN 2/3] failed again' })
    expect(spy.calls).toHaveLength(3)
    // System prompts must be byte-identical so Anthropic prompt cache reuses
    // the planner system prompt across the initial plan and all replans.
    expect(spy.calls[0].system).toBe(spy.calls[1].system)
    expect(spy.calls[1].system).toBe(spy.calls[2].system)
  })
})
