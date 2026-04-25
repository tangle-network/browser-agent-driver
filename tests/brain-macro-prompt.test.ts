import { describe, it, expect } from 'vitest'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.com/',
    title: 'example',
    snapshot: '- heading "Example"',
    ...overrides,
  }
}

/** Access the private composeSystemPromptParts for assertion. Vitest-standard
 * pattern for narrow white-box tests. */
function composeParts(brain: Brain, goal: string, state: PageState, turn: number): string[] {
  return (brain as unknown as { composeSystemPromptParts: (g: string, s: PageState, t: number) => string[] })
    .composeSystemPromptParts(goal, state, turn)
}

describe('Brain.setMacroPromptBlock — prompt injection', () => {
  it('includes the macro block in the composed system prompt when set', () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    brain.setMacroPromptBlock('USER MACROS (invoke via …):\n- foo — does the foo')
    const parts = composeParts(brain, 'do a thing', makeState(), 1)
    const joined = parts.join('')
    expect(joined).toContain('USER MACROS (invoke via …):')
    expect(joined).toContain('- foo — does the foo')
  })

  it('omits the macro block after reset to empty string', () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    brain.setMacroPromptBlock('USER MACROS (invoke via …):\n- foo — does the foo')
    let parts = composeParts(brain, 'do a thing', makeState(), 1)
    expect(parts.join('')).toContain('USER MACROS')

    brain.setMacroPromptBlock('')
    parts = composeParts(brain, 'do a thing', makeState(), 1)
    expect(parts.join('')).not.toContain('USER MACROS')
    expect(parts.join('')).not.toContain('does the foo')
  })

  it('has no macro block by default', () => {
    const brain = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const parts = composeParts(brain, 'do a thing', makeState(), 1)
    expect(parts.join('')).not.toContain('USER MACROS')
  })

  it('macro block lives after REASONING_SUFFIX so the Anthropic cache prefix stays byte-stable', () => {
    // CORE_RULES (cached) must be the very first part. Changing the macro
    // block must not cause the cached slot at index 0 to differ.
    const brain1 = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    const brain2 = new Brain({ provider: 'openai', apiKey: 'sk-test' })
    brain2.setMacroPromptBlock('USER MACROS:\n- foo — does the foo')
    const a = composeParts(brain1, 'do a thing', makeState(), 1)
    const b = composeParts(brain2, 'do a thing', makeState(), 1)
    // Same first slot (CORE_RULES) whether or not macros are loaded.
    expect(a[0]).toBe(b[0])
    // Different overall output.
    expect(a.join('')).not.toBe(b.join(''))
  })
})
