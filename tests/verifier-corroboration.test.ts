/**
 * Wave-2 verifier tests: evidence-corroborated completion (the
 * over-conservatism fix), slim verification path, and verifier token
 * recording into run metrics.
 */

import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { evidenceCorroboratesResult } from '../src/runner/completion-policy.js'
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
