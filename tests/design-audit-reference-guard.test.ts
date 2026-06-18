import { describe, it, expect } from 'vitest'
import { decideProceed } from '../src/design/audit/reference/engine/guard.js'
import type { DesignDNA, ReferenceContext } from '../src/design/audit/reference/contracts.js'

// Minimal valid DNA — the guard never reads its fields, but we keep the fixture
// type-honest rather than casting an empty object.
const dna: DesignDNA = {
  url: 'https://ref.example',
  capturedAt: '2026-01-01T00:00:00.000Z',
  type: { steps: [], families: [] },
  color: { roles: { primary: [], secondary: [], accent: [], neutral: [], background: [], border: [] } },
  spacing: { steps: [], density: 'balanced' },
  radii: { steps: [] },
  motion: { durationsMs: [], easings: [], libraries: [] },
  layout: { density: 'balanced', archetype: 'content-flow' },
  components: { buttons: 0, inputs: 0, cards: 0, nav: 0 },
}

const reference: ReferenceContext = { kind: 'url', dna, summary: 'a reference' }

describe('decideProceed (fail-closed guard)', () => {
  it('aborts with a reason when the corpus is empty and there is no reference', () => {
    const d = decideProceed({ corpusSize: 0, retrieved: 0 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/corpus/i)
  })

  it('aborts with a distinct reason when retrieval is empty (non-empty corpus, no reference)', () => {
    const d = decideProceed({ corpusSize: 12, retrieved: 0 })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/retrieved 0|nothing to ground/i)
  })

  it('proceeds when a reference is supplied even with an empty corpus', () => {
    expect(decideProceed({ corpusSize: 0, retrieved: 0, reference })).toEqual({ ok: true })
  })

  it('proceeds when the corpus and retrieval are both non-empty', () => {
    expect(decideProceed({ corpusSize: 12, retrieved: 4 })).toEqual({ ok: true })
  })

  it('treats non-finite or negative counts as empty (fail-closed)', () => {
    expect(decideProceed({ corpusSize: Number.NaN, retrieved: 4 }).ok).toBe(false)
    expect(decideProceed({ corpusSize: 5, retrieved: -1 }).ok).toBe(false)
  })
})
