/**
 * Demo-mode override helpers — pure function coverage.
 *
 * Ensures:
 *   - Production runs (no env vars) return the decision unchanged.
 *   - BAD_FORCE_FANOUT_TURN fires only on that specific turn.
 *   - Malformed JSON surfaces as an override-applied event, not a crash.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { applyDemoOverride } from '../src/runner/demo-overrides.js'
import type { Action } from '../src/types.js'

const BASE: Action = { action: 'click', selector: '@b1' }

const keys = ['BAD_FORCE_FANOUT_TURN', 'BAD_FORCE_FANOUT_SUBGOALS_JSON'] as const
type Key = (typeof keys)[number]

describe('applyDemoOverride', () => {
  const saved: Record<Key, string | undefined> = { BAD_FORCE_FANOUT_TURN: undefined, BAD_FORCE_FANOUT_SUBGOALS_JSON: undefined }
  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('production run (no env vars) returns the decision unchanged', () => {
    const r = applyDemoOverride({ turn: 5, action: BASE, reasoning: 'x', expectedEffect: 'y' })
    expect(r.action).toBe(BASE)
    expect(r.reasoning).toBe('x')
    expect(r.expectedEffect).toBe('y')
    expect(r.override).toBeUndefined()
  })

  it('force-fanout fires on the specified turn, replaces the action', () => {
    process.env.BAD_FORCE_FANOUT_TURN = '5'
    process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON = JSON.stringify([
      { url: 'https://a.test/', goal: 'do A', label: 'A' },
      { url: 'https://b.test/', goal: 'do B', label: 'B' },
    ])
    const r = applyDemoOverride({ turn: 5, action: BASE })
    expect(r.action.action).toBe('fanOut')
    if (r.action.action === 'fanOut') {
      expect(r.action.subGoals).toHaveLength(2)
      expect(r.action.subGoals[0].label).toBe('A')
    }
    expect(r.override?.tag).toBe('demo-force-fanout')
    expect(r.reasoning).toContain('Demo override')
  })

  it('force-fanout does NOT fire on a different turn', () => {
    process.env.BAD_FORCE_FANOUT_TURN = '5'
    process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON = JSON.stringify([{ url: 'x', goal: 'y' }])
    const r = applyDemoOverride({ turn: 4, action: BASE })
    expect(r.action).toBe(BASE)
    expect(r.override).toBeUndefined()
  })

  it('force-fanout without subgoals env is a no-op', () => {
    process.env.BAD_FORCE_FANOUT_TURN = '5'
    const r = applyDemoOverride({ turn: 5, action: BASE })
    expect(r.action).toBe(BASE)
    expect(r.override).toBeUndefined()
  })

  it('force-fanout with malformed JSON surfaces as parse-error override', () => {
    process.env.BAD_FORCE_FANOUT_TURN = '5'
    process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON = 'not-json{'
    const r = applyDemoOverride({ turn: 5, action: BASE })
    expect(r.override?.tag).toBe('demo-force-fanout-parse-error')
    expect(r.override?.feedback).toContain('parse error')
  })

  it('force-fanout with empty array is a no-op', () => {
    process.env.BAD_FORCE_FANOUT_TURN = '5'
    process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON = '[]'
    const r = applyDemoOverride({ turn: 5, action: BASE })
    expect(r.action).toBe(BASE)
    expect(r.override).toBeUndefined()
  })

  it('force-fanout with invalid turn number (0 / negative / NaN) is a no-op', () => {
    process.env.BAD_FORCE_FANOUT_SUBGOALS_JSON = JSON.stringify([{ url: 'x', goal: 'y' }])
    for (const bad of ['0', '-1', 'abc']) {
      process.env.BAD_FORCE_FANOUT_TURN = bad
      const r = applyDemoOverride({ turn: 5, action: BASE })
      expect(r.action, `turn=${bad}`).toBe(BASE)
    }
  })
})
