/**
 * Tests for the system-prompt construction with Anthropic prompt-cache markers.
 *
 * `buildSystemForDecide` returns either a plain string (for non-Anthropic
 * providers) or a `SystemModelMessage[]` where the first slot carries
 * `cache_control: ephemeral` on CORE_RULES and the remaining fragments
 * follow as a separate uncached message.
 *
 * These tests poke the private method via a typed cast — the goal is a
 * regression guard so a future refactor can't accidentally drop the cache
 * marker or move it off the stable prefix.
 */

import { describe, expect, it } from 'vitest'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'

type BrainInternals = Brain & {
  buildSystemForDecide(
    goal: string,
    state: PageState,
    turn: number,
    provider: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
  ): string | Array<{ role: 'system'; content: string; providerOptions?: Record<string, unknown> }>
}

const STATE: PageState = {
  url: 'https://example.com',
  title: 'Example',
  snapshot: '[ref=b1] button "Click me"\n[ref=t2] textbox "Search"',
}

describe('Brain.buildSystemForDecide — Anthropic cache markers', () => {
  it('returns a plain string for non-Anthropic providers', () => {
    const brain = new Brain() as BrainInternals
    const result = brain.buildSystemForDecide('say hi', STATE, 1, 'openai')
    expect(typeof result).toBe('string')
    expect(result as string).toContain('senior staff engineer')
  })

  it('returns a SystemModelMessage[] for anthropic with cache_control on CORE_RULES', () => {
    const brain = new Brain() as BrainInternals
    const result = brain.buildSystemForDecide('say hi', STATE, 1, 'anthropic')
    expect(Array.isArray(result)).toBe(true)
    const arr = result as Array<{ role: 'system'; content: string; providerOptions?: Record<string, unknown> }>
    expect(arr.length).toBeGreaterThan(0)
    // First slot is the stable cached prefix
    expect(arr[0].role).toBe('system')
    expect(arr[0].content).toContain('senior staff engineer') // CORE_RULES preamble
    expect(arr[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
  })

  it('places conditional fragments in a separate uncached slot', () => {
    const brain = new Brain() as BrainInternals
    // Heavy snapshot triggers HEAVY_PAGE_RULES, so we should get >1 part
    const heavyState: PageState = {
      ...STATE,
      snapshot: 'a'.repeat(11_000),
    }
    const result = brain.buildSystemForDecide('say hi', heavyState, 1, 'anthropic') as Array<{
      role: 'system'
      content: string
      providerOptions?: Record<string, unknown>
    }>
    expect(result.length).toBe(2)
    // CORE_RULES is in slot 0 with cache_control
    expect(result[0].providerOptions?.anthropic).toBeDefined()
    // Conditional fragments + REASONING_SUFFIX are in slot 1, uncached
    expect(result[1].providerOptions).toBeUndefined()
    expect(result[1].content).toContain('HEAVY PAGE RECOVERY')
  })

  it('byte-stable CORE_RULES across turns enables cache hits', () => {
    const brain = new Brain() as BrainInternals
    const t1 = brain.buildSystemForDecide('goal A', STATE, 1, 'anthropic') as Array<{ content: string }>
    const t2 = brain.buildSystemForDecide('goal B', STATE, 5, 'anthropic') as Array<{ content: string }>
    // First slot must be byte-identical even when goal/turn differ — that's the
    // whole point of the cache breakpoint placement.
    expect(t1[0].content).toBe(t2[0].content)
  })

  it('falls back to plain string when a custom systemPrompt is configured', () => {
    const brain = new Brain({ systemPrompt: 'CUSTOM PROMPT BODY' }) as BrainInternals
    const result = brain.buildSystemForDecide('say hi', STATE, 1, 'anthropic')
    expect(typeof result).toBe('string')
    expect(result).toBe('CUSTOM PROMPT BODY')
  })
})
