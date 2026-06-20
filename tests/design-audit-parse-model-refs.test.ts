import { describe, it, expect } from 'vitest'
import { parseModelRefs } from '../src/cli-design-audit.js'

// --judge-models is user input; these lock the edge cases (empty, bare model,
// provider:model, whitespace, blanks, colon-less, missing model after colon).
describe('parseModelRefs', () => {
  it('returns [] for empty/absent input', () => {
    expect(parseModelRefs(undefined)).toEqual([])
    expect(parseModelRefs('')).toEqual([])
    expect(parseModelRefs('   ')).toEqual([])
  })

  it('parses provider:model pairs', () => {
    expect(parseModelRefs('openai:gpt-5.4,anthropic:claude-opus-4-8')).toEqual([
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'anthropic', model: 'claude-opus-4-8' },
    ])
  })

  it('leaves provider unset for a bare model (wiring fills the default)', () => {
    expect(parseModelRefs('gpt-5.4')).toEqual([{ model: 'gpt-5.4' }])
  })

  it('splits on the FIRST colon — model names may contain colons', () => {
    expect(parseModelRefs('openai:ft:gpt:v2')).toEqual([{ provider: 'openai', model: 'ft:gpt:v2' }])
  })

  it('trims whitespace and skips blank entries', () => {
    expect(parseModelRefs(' openai : gpt-5.4 , , claude-code:sonnet ')).toEqual([
      { provider: 'openai', model: 'gpt-5.4' },
      { provider: 'claude-code', model: 'sonnet' },
    ])
  })

  it('skips an entry with a provider but no model', () => {
    expect(parseModelRefs('openai:,anthropic:claude-opus-4-8')).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4-8' },
    ])
  })
})
