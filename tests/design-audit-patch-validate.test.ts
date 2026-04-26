import { describe, it, expect } from 'vitest'
import { validatePatch, validatePatches } from '../src/design/audit/patches/validate.js'
import type { Patch } from '../src/design/audit/v2/types.js'

const basePatch: Patch = {
  patchId: 'p1',
  findingId: 'f1',
  scope: 'component',
  target: { scope: 'css', cssSelector: '.btn' },
  diff: { before: 'color: red', after: 'color: green' },
  testThatProves: { kind: 'rerun-audit', description: 'Score improves.' },
  rollback: { kind: 'git-revert' },
  estimatedDelta: { dim: 'visual_craft', delta: 1 },
  estimatedDeltaConfidence: 'untested',
}

const snapshot = 'The page has: color: red and font-size: 14px'

describe('validatePatch', () => {
  it('passes when before is in snapshot and locator present', () => {
    const result = validatePatch(basePatch, snapshot)
    expect(result.valid).toBe(true)
    expect(result.reasons).toHaveLength(0)
  })

  it('fails when before is not in snapshot', () => {
    const result = validatePatch({ ...basePatch, diff: { before: 'color: purple', after: 'x' } }, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons).toContain('before-not-in-snapshot')
  })

  it('fails when before is empty string', () => {
    const result = validatePatch({ ...basePatch, diff: { before: '', after: 'x' } }, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons).toContain('before-empty')
  })

  it('fails when target has no locator', () => {
    const patch: Patch = { ...basePatch, target: { scope: 'css' } }
    const result = validatePatch(patch, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons).toContain('target-missing-locator')
  })

  it('fails when estimatedDelta.delta is out of range (> 3)', () => {
    const result = validatePatch({ ...basePatch, estimatedDelta: { dim: 'visual_craft', delta: 5 } }, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons).toContain('estimated-delta-out-of-range')
  })

  it('fails when estimatedDelta.delta is out of range (< -3)', () => {
    const result = validatePatch({ ...basePatch, estimatedDelta: { dim: 'visual_craft', delta: -4 } }, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons).toContain('estimated-delta-out-of-range')
  })

  it('accumulates multiple failures in one pass', () => {
    const patch: Patch = {
      ...basePatch,
      target: { scope: 'css' },
      diff: { before: 'not present', after: 'x' },
      estimatedDelta: { dim: 'visual_craft', delta: 99 },
    }
    const result = validatePatch(patch, snapshot)
    expect(result.valid).toBe(false)
    expect(result.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('validatePatches', () => {
  it('partitions valid and invalid patches', () => {
    const valid = basePatch
    const invalid: Patch = { ...basePatch, diff: { before: 'not-here', after: 'x' } }
    const result = validatePatches([valid, invalid], snapshot)
    expect(result.valid).toHaveLength(1)
    expect(result.invalid).toHaveLength(1)
  })
})
