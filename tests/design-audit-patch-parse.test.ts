import { describe, it, expect } from 'vitest'
import { parsePatch, parsePatches } from '../src/design/audit/patches/parse.js'

const validPatch = {
  patchId: 'patch-001',
  findingId: 'finding-001',
  scope: 'component',
  target: { scope: 'css', cssSelector: '.hero-cta' },
  diff: { before: 'background: blue', after: 'background: #2563eb' },
  testThatProves: { kind: 'rerun-audit', description: 'Re-run audit and verify visual_craft score improves.' },
  rollback: { kind: 'git-revert' },
  estimatedDelta: { dim: 'visual_craft', delta: 1 },
  estimatedDeltaConfidence: 'untested',
}

describe('parsePatch', () => {
  it('accepts a fully valid patch', () => {
    const { patch, reason } = parsePatch(validPatch)
    expect(patch).not.toBeNull()
    expect(reason).toBeUndefined()
    expect(patch!.patchId).toBe('patch-001')
  })

  it('accepts optional unifiedDiff', () => {
    const { patch } = parsePatch({ ...validPatch, diff: { ...validPatch.diff, unifiedDiff: '--- a/f\n+++ b/f\n' } })
    expect(patch?.diff.unifiedDiff).toBeDefined()
  })

  it('rejects non-object input', () => {
    const { patch, reason } = parsePatch('not an object')
    expect(patch).toBeNull()
    expect(reason).toMatch(/not an object/)
  })

  it('rejects missing patchId', () => {
    const { patch, reason } = parsePatch({ ...validPatch, patchId: '' })
    expect(patch).toBeNull()
    expect(reason).toMatch(/patchId/)
  })

  it('rejects missing findingId', () => {
    const { patch, reason } = parsePatch({ ...validPatch, findingId: undefined })
    expect(patch).toBeNull()
    expect(reason).toMatch(/findingId/)
  })

  it('rejects invalid scope', () => {
    const { patch, reason } = parsePatch({ ...validPatch, scope: 'galaxy' })
    expect(patch).toBeNull()
    expect(reason).toMatch(/scope/)
  })

  it('rejects invalid target.scope', () => {
    const { patch, reason } = parsePatch({ ...validPatch, target: { scope: 'cobol', cssSelector: '.x' } })
    expect(patch).toBeNull()
    expect(reason).toMatch(/target.scope/)
  })

  it('rejects missing diff.before', () => {
    const { patch, reason } = parsePatch({ ...validPatch, diff: { before: '', after: 'x' } })
    expect(patch).toBeNull()
    expect(reason).toMatch(/diff.before/)
  })

  it('rejects invalid testThatProves.kind', () => {
    const { patch, reason } = parsePatch({ ...validPatch, testThatProves: { kind: 'vibes', description: 'idk' } })
    expect(patch).toBeNull()
    expect(reason).toMatch(/testThatProves.kind/)
  })

  it('rejects invalid rollback.kind', () => {
    const { patch, reason } = parsePatch({ ...validPatch, rollback: { kind: 'prayer' } })
    expect(patch).toBeNull()
    expect(reason).toMatch(/rollback.kind/)
  })

  it('rejects invalid estimatedDeltaConfidence', () => {
    const { patch, reason } = parsePatch({ ...validPatch, estimatedDeltaConfidence: 'godlike' })
    expect(patch).toBeNull()
    expect(reason).toMatch(/estimatedDeltaConfidence/)
  })
})

describe('parsePatches', () => {
  it('parses an array of patches, dropping invalid entries', () => {
    const raw = [validPatch, { patchId: '' }, validPatch]
    const { patches, errors } = parsePatches(raw)
    expect(patches).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0].index).toBe(1)
  })

  it('returns error when input is not an array', () => {
    const { patches, errors } = parsePatches('oops')
    expect(patches).toHaveLength(0)
    expect(errors[0].index).toBe(-1)
  })
})
