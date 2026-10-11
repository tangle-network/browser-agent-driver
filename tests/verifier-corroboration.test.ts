/**
 * Wave-2 verifier tests: evidence-corroborated completion (the
 * over-conservatism fix), slim verification path, and verifier token
 * recording into run metrics.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { evidenceCorroboratesResult, goalLiteralsCorroborated } from '../src/runner/completion-policy.js'
import { verifyGoalCompletionImpl, type BrainGoalVerificationHost } from '../src/brain/tasks/goal-verification.js'
import type { PageState } from '../src/types/page.js'

// ── evidenceCorroboratesResult (verifier over-conservatism fix) ─────────

describe('evidenceCorroboratesResult', () => {
  const evidence = ['SCRIPT RESULT:\n{"title": "LineageOS 24.0", "score": 48, "comments": 9}']

  it('accepts a claim that echoes script-result values exactly (the hn rep3 case)', () => {
    expect(evidenceCorroboratesResult('{"title": "LineageOS 24.0", "score": 48, "comments": 9}', evidence)).toBe(true)
  })

  it('accepts a subset claim (every claimed key must match)', () => {
    expect(evidenceCorroboratesResult('{"score": 48}', evidence)).toBe(true)
  })

  it('rejects a hallucinated value', () => {
    expect(evidenceCorroboratesResult('{"title": "LineageOS 24.0", "score": 51, "comments": 9}', evidence)).toBe(false)
  })

  it('rejects empty claimed values', () => {
    expect(evidenceCorroboratesResult('{"title": "", "score": 48}', evidence)).toBe(false)
  })

  it('rejects non-JSON claims and missing evidence', () => {
    expect(evidenceCorroboratesResult('The top story is LineageOS 24.0', evidence)).toBe(false)
    expect(evidenceCorroboratesResult('{"score": 48}', ['EXTRACT RESULT (2 matches):\nsome text'])).toBe(false)
  })

  it('matches numeric values across string/number types', () => {
    expect(evidenceCorroboratesResult('{"year": 1815}', ['SCRIPT RESULT:\n{"year": "1815"}'])).toBe(true)
  })
})

// ── verifyGoalCompletionImpl slim path + token recording ────────────────

function fakeHost(rawResponse: string): BrainGoalVerificationHost & { calls: { system: unknown; messages: ModelMessage[]; maxTokens?: number }[] } {
  const calls: { system: unknown; messages: ModelMessage[]; maxTokens?: number }[] = []
  return {
    calls,
    provider: 'google',
    debug: false,
    adaptiveModelRouting: false,
    buildUserContent: (text) => text,
    generate: async (system, messages, _sel, maxTokens) => {
      calls.push({ system, messages, maxTokens })
      return { text: rawResponse, inputTokens: 1234, outputTokens: 56, cacheReadInputTokens: 789 }
    },
  }
}

const STATE = { url: 'https://news.ycombinator.com/', title: 'HN', snapshot: '- link "x" [ref=l1]', screenshot: 'b64' } as unknown as PageState

describe('verifyGoalCompletionImpl', () => {
  it('records the verifier call token usage on the verdict', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    const out = await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(out.achieved).toBe(true)
    expect(out.inputTokens).toBe(1234)
    expect(out.outputTokens).toBe(56)
    expect(out.cacheReadInputTokens).toBe(789)
  })

  it('skipPageState drops the ELEMENTS snapshot from the verifier prompt', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim', { skipPageState: true })
    const userText = String(host.calls[0].messages[0].content)
    expect(userText).not.toContain('ELEMENTS:')
    expect(userText).not.toContain('[ref=l1]')
  })

  it('default path keeps the page snapshot', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(String(host.calls[0].messages[0].content)).toContain('ELEMENTS:')
  })

  it('parse-failure path still records token usage', async () => {
    const host = fakeHost('not json at all')
    const out = await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(out.achieved).toBe(false)
    expect(out.inputTokens).toBe(1234)
  })
})

describe('verifyGoalCompletionImpl output cap (wave 4)', () => {
  it('uses a 4096 cap for google (thinking counts against maxOutputTokens)', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(host.calls[0].maxTokens).toBe(4096)
  })

  it('keeps the 600 cap for non-google providers', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    host.provider = 'openai'
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(host.calls[0].maxTokens).toBe(600)
  })
})

describe('verifyGoalCompletionImpl sub-call routing (BAD_SUBCALL_MODEL)', () => {
  afterEach(() => {
    delete process.env.BAD_SUBCALL_MODEL
  })

  it('routes verification to the sub-call model when set', async () => {
    process.env.BAD_SUBCALL_MODEL = 'gemini-2.5-flash-lite'
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    const selections: unknown[] = []
    const origGenerate = host.generate
    host.generate = async (system: unknown, messages: never[], selection: unknown, maxTokens?: number) => {
      selections.push(selection)
      return origGenerate(system, messages, selection as never, maxTokens)
    }
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(selections[0]).toEqual({ provider: 'google', model: 'gemini-2.5-flash-lite' })
  })

  it('uses the primary model by default (no selection override)', async () => {
    const host = fakeHost('{"achieved":true,"confidence":0.9,"evidence":[],"missing":[]}')
    const selections: unknown[] = []
    const origGenerate = host.generate
    host.generate = async (system: unknown, messages: never[], selection: unknown, maxTokens?: number) => {
      selections.push(selection)
      return origGenerate(system, messages, selection as never, maxTokens)
    }
    await verifyGoalCompletionImpl(host, STATE, 'goal', 'claim')
    expect(selections[0]).toBeUndefined()
  })
})

describe('goalLiteralsCorroborated (text-in-snapshot corroboration)', () => {
  const goal = "Fill the form. Verify the success message 'Account Created!' appears."

  it('corroborates when every quoted literal appears verbatim in the final snapshot', () => {
    expect(goalLiteralsCorroborated(goal, '- heading "Account Created!" [ref=h1]\n- text "Check your email"', [])).toBe(true)
  })

  it('corroborates via script evidence when the literal is not in the snapshot', () => {
    expect(goalLiteralsCorroborated(goal, '- heading "Done"', ['SCRIPT RESULT:\nAccount Created!'])).toBe(true)
  })

  it('rejects when any literal is missing (strict: exact presence required)', () => {
    expect(goalLiteralsCorroborated(goal, '- heading "Account"', [])).toBe(false)
    expect(goalLiteralsCorroborated("Do X then verify 'Banner A' and 'Banner B' show", 'Banner A is here', [])).toBe(false)
  })

  it('rejects goals with no quoted literals', () => {
    expect(goalLiteralsCorroborated('Fill the form and submit it', 'anything', [])).toBe(false)
  })

  it('ignores literals shorter than 4 chars', () => {
    expect(goalLiteralsCorroborated("Click 'OK' to continue", 'nothing here', [])).toBe(false)
  })
})

describe('goalLiteralsCorroborated — form-consume flows (wave 5 refinement)', () => {
  const formGoal = "Fill every field: name 'Jordan', plan select 'Pro ($9/mo)'. Verify the success message 'Account Created!' appears."

  it('corroborates when consumed field values live in prior observations and the banner in the final one', () => {
    const finalSnap = '- heading "Account Created!" [ref=h1]'
    const priorSnaps = ['- textbox "First Name" [value="Jordan"]\n- option "Pro ($9/mo)" [selected]']
    expect(goalLiteralsCorroborated(formGoal, finalSnap, [], priorSnaps)).toBe(true)
  })

  it('still rejects when a literal appears nowhere in the run', () => {
    const finalSnap = '- heading "Account Created!" [ref=h1]'
    const priorSnaps = ['- textbox "First Name" [value="Alex"]']
    expect(goalLiteralsCorroborated(formGoal, finalSnap, [], priorSnaps)).toBe(false)
  })
})
