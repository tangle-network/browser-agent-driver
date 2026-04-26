import { describe, it, expect } from 'vitest'
import { emptyScorecard, summarize, statusFor, type FlowEnvelope } from '../bench/design/eval/scorecard.js'

describe('emptyScorecard', () => {
  it('returns the canonical empty shape', () => {
    const s = emptyScorecard(7)
    expect(s.product).toBe('browser-agent-driver')
    expect(s.track).toBe('track-2-design-audit')
    expect(s.generation).toBe(7)
    expect(s.flows).toEqual([])
    expect(s.summary).toEqual({ pass: 0, total: 0, unmeasured: 0 })
  })
})

describe('statusFor', () => {
  it('handles >= comparator', () => {
    expect(statusFor(0.8, 0.7, '>=')).toBe('pass')
    expect(statusFor(0.6, 0.7, '>=')).toBe('fail')
    expect(statusFor(0.7, 0.7, '>=')).toBe('pass')
  })
  it('handles <= comparator', () => {
    expect(statusFor(0.4, 0.5, '<=')).toBe('pass')
    expect(statusFor(0.6, 0.5, '<=')).toBe('fail')
  })
  it('returns unmeasured for NaN', () => {
    expect(statusFor(NaN, 0.5, '>=')).toBe('unmeasured')
    expect(statusFor(NaN, 0.5, '<=')).toBe('unmeasured')
  })
})

describe('summarize', () => {
  it('counts pass/total/unmeasured correctly', () => {
    const flows: FlowEnvelope[] = [
      { name: 'a', description: '', score: 1, target: 0.5, comparator: '>=', status: 'pass', notes: '' },
      { name: 'b', description: '', score: 0, target: 0.5, comparator: '>=', status: 'fail', notes: '' },
      { name: 'c', description: '', score: NaN, target: 0.5, comparator: '>=', status: 'unmeasured', notes: '' },
    ]
    expect(summarize(flows)).toEqual({ pass: 1, total: 3, unmeasured: 1 })
  })
})
