import { describe, it, expect } from 'vitest'
import {
  DEFAULT_REFERENCE_CONFIG,
  DEFAULT_RETRIEVE_WEIGHTS,
  resolveReferenceConfig,
} from '../src/design/audit/reference/config.js'

describe('DEFAULT_REFERENCE_CONFIG (pure defaults)', () => {
  it('exposes stable, frozen defaults tuned for the offline path', () => {
    expect(DEFAULT_REFERENCE_CONFIG.k).toBe(4)
    expect(DEFAULT_REFERENCE_CONFIG.directionCount).toBe(3)
    expect(DEFAULT_REFERENCE_CONFIG.judge).toBe('text')
    expect(DEFAULT_REFERENCE_CONFIG.embedder).toBe('deterministic')
    expect(DEFAULT_REFERENCE_CONFIG.budget).toEqual({
      maxGenerationCalls: 3,
      maxJudgeCalls: 24,
      judgeReps: 1,
      concurrency: 4,
      screenThenValidate: false,
    })
    expect(Object.isFrozen(DEFAULT_REFERENCE_CONFIG)).toBe(true)
    expect(Object.isFrozen(DEFAULT_REFERENCE_CONFIG.budget)).toBe(true)
  })

  it('weights aesthetic similarity above structural above the noisy job signal', () => {
    expect(DEFAULT_RETRIEVE_WEIGHTS.aesthetic).toBeGreaterThan(DEFAULT_RETRIEVE_WEIGHTS.structural)
    expect(DEFAULT_RETRIEVE_WEIGHTS.structural).toBeGreaterThan(DEFAULT_RETRIEVE_WEIGHTS.job)
    expect(Object.isFrozen(DEFAULT_RETRIEVE_WEIGHTS)).toBe(true)
  })
})

describe('resolveReferenceConfig (clamped merge)', () => {
  it('returns the defaults (by value) when given no overrides', () => {
    const cfg = resolveReferenceConfig()
    expect(cfg).toEqual({
      corpusDir: DEFAULT_REFERENCE_CONFIG.corpusDir,
      artifactDir: DEFAULT_REFERENCE_CONFIG.artifactDir,
      k: DEFAULT_REFERENCE_CONFIG.k,
      directionCount: DEFAULT_REFERENCE_CONFIG.directionCount,
      judge: DEFAULT_REFERENCE_CONFIG.judge,
      embedder: DEFAULT_REFERENCE_CONFIG.embedder,
      budget: { ...DEFAULT_REFERENCE_CONFIG.budget },
      reference: DEFAULT_REFERENCE_CONFIG.reference,
      model: DEFAULT_REFERENCE_CONFIG.model,
    })
  })

  it('returns a fresh, mutable object — never the frozen default', () => {
    const cfg = resolveReferenceConfig()
    expect(Object.isFrozen(cfg)).toBe(false)
    expect(cfg).not.toBe(DEFAULT_REFERENCE_CONFIG)
    expect(cfg.budget).not.toBe(DEFAULT_REFERENCE_CONFIG.budget)
    // mutating the result must not corrupt the shared default
    cfg.k = 9
    expect(DEFAULT_REFERENCE_CONFIG.k).toBe(4)
  })

  it('merges top-level overrides field-by-field, leaving the rest at default', () => {
    const cfg = resolveReferenceConfig({ corpusDir: '/tmp/corpus', k: 6, judge: 'vision' })
    expect(cfg.corpusDir).toBe('/tmp/corpus')
    expect(cfg.k).toBe(6)
    expect(cfg.judge).toBe('vision')
    // untouched fields fall through to the defaults
    expect(cfg.directionCount).toBe(DEFAULT_REFERENCE_CONFIG.directionCount)
    expect(cfg.embedder).toBe(DEFAULT_REFERENCE_CONFIG.embedder)
    expect(cfg.budget).toEqual(DEFAULT_REFERENCE_CONFIG.budget)
  })

  it('merges a partial budget field-by-field without restating the bundle', () => {
    const cfg = resolveReferenceConfig({ budget: { judgeReps: 3 } })
    expect(cfg.budget.judgeReps).toBe(3)
    // every other budget field comes from the default
    expect(cfg.budget.maxGenerationCalls).toBe(DEFAULT_REFERENCE_CONFIG.budget.maxGenerationCalls)
    expect(cfg.budget.maxJudgeCalls).toBe(DEFAULT_REFERENCE_CONFIG.budget.maxJudgeCalls)
    expect(cfg.budget.concurrency).toBe(DEFAULT_REFERENCE_CONFIG.budget.concurrency)
    expect(cfg.budget.screenThenValidate).toBe(DEFAULT_REFERENCE_CONFIG.budget.screenThenValidate)
  })

  it('clamps counts and budget knobs to their minimums', () => {
    const cfg = resolveReferenceConfig({
      k: 0,
      directionCount: -3,
      budget: { maxGenerationCalls: 0, maxJudgeCalls: -10, judgeReps: 0, concurrency: 0 },
    })
    expect(cfg.k).toBe(1)
    expect(cfg.directionCount).toBe(1)
    expect(cfg.budget.maxGenerationCalls).toBe(1)
    expect(cfg.budget.maxJudgeCalls).toBe(1)
    expect(cfg.budget.judgeReps).toBe(1)
    expect(cfg.budget.concurrency).toBe(1)
  })

  it('rounds fractional counts and falls back to the default on non-finite overrides', () => {
    expect(resolveReferenceConfig({ k: 2.6 }).k).toBe(3)
    expect(resolveReferenceConfig({ k: Number.NaN }).k).toBe(DEFAULT_REFERENCE_CONFIG.k)
    expect(resolveReferenceConfig({ budget: { maxJudgeCalls: Number.POSITIVE_INFINITY } }).budget.maxJudgeCalls).toBe(
      DEFAULT_REFERENCE_CONFIG.budget.maxJudgeCalls,
    )
  })
})
