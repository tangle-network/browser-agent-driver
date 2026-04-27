/**
 * Unit tests for the second-call patch generator. Brain is stubbed; we
 * assert the prompt + response wiring, NOT real LLM behavior.
 */

import { describe, it, expect } from 'vitest'
import { generatePatches } from '../src/design/audit/patches/generate.js'
import type { Brain } from '../src/brain/index.js'
import type { DesignFinding } from '../src/design/audit/score-types.js'

function makeBrain(text: string): Brain {
  return {
    complete: async () => ({ text, tokensUsed: 42 }),
  } as unknown as Brain
}

const sampleFindings: DesignFinding[] = [
  {
    id: 'f-1',
    category: 'ux',
    severity: 'major',
    description: 'Hero CTA underweighted',
    location: 'hero',
    suggestion: 'enlarge',
    impact: 8, effort: 2, blast: 'section',
    dimension: 'visual_craft',
    kind: 'polish',
    patches: [],
  },
  {
    id: 'f-2',
    category: 'spacing',
    severity: 'minor',
    description: 'minor spacing nit',
    location: 'cards',
    suggestion: 'tighter',
    impact: 3, effort: 1, blast: 'page',
    dimension: 'visual_craft',
    kind: 'polish',
    patches: [],
  },
]

describe('generatePatches', () => {
  it('skips when no major/critical findings exist', async () => {
    const brain = makeBrain('{"patches":[]}')
    const out = await generatePatches({ brain, snapshot: 'snap', findings: [sampleFindings[1]] })
    expect(out.tokensUsed).toBe(0)
    expect(out.findings[0].rawPatches).toBeUndefined()
  })

  it('attaches a parsed patch to the matching finding', async () => {
    const llmResponse = JSON.stringify({
      patches: [
        {
          findingId: 'f-1',
          patch: {
            patchId: 'p-1',
            findingId: 'f-1',
            scope: 'section',
            target: { scope: 'css', cssSelector: 'section.hero button' },
            diff: { before: 'padding: 8px 14px', after: 'padding: 12px 20px' },
            testThatProves: { kind: 'rerun-audit', description: 'Hero CTA size lifts visual_craft.' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'medium',
          },
        },
      ],
    })
    const brain = makeBrain(llmResponse)
    const out = await generatePatches({ brain, snapshot: 'snap', findings: sampleFindings })
    const f1 = out.findings.find(f => f.id === 'f-1')
    expect(f1?.rawPatches).toBeDefined()
    expect(f1?.rawPatches).toHaveLength(1)
    expect(out.tokensUsed).toBe(42)
    expect(out.notes).toEqual([])
  })

  it('does not crash on malformed LLM output, just records a note', async () => {
    const brain = makeBrain('not json at all')
    const out = await generatePatches({ brain, snapshot: 'snap', findings: sampleFindings })
    expect(out.findings[0].rawPatches).toBeUndefined()
    expect(out.notes.some(n => n.findingId === 'f-1')).toBe(true)
  })

  it('records a note for findings missing from the LLM response', async () => {
    const brain = makeBrain('{"patches":[]}')
    const out = await generatePatches({ brain, snapshot: 'snap', findings: sampleFindings })
    expect(out.notes.find(n => n.findingId === 'f-1')?.reason).toMatch(/no patch in generator response/)
  })

  it('overrides findingId on the patch even when LLM emitted a placeholder', async () => {
    const llmResponse = JSON.stringify({
      patches: [
        {
          findingId: 'f-1',
          patch: {
            patchId: 'p-1',
            findingId: 'placeholder-from-llm',
            scope: 'section',
            target: { scope: 'css', cssSelector: '.x' },
            diff: { before: 'a', after: 'b' },
            testThatProves: { kind: 'rerun-audit', description: 'x' },
            rollback: { kind: 'css-disable' },
            estimatedDelta: { dim: 'visual_craft', delta: 1 },
            estimatedDeltaConfidence: 'medium',
          },
        },
      ],
    })
    const brain = makeBrain(llmResponse)
    const out = await generatePatches({ brain, snapshot: 'snap', findings: sampleFindings })
    const f1 = out.findings.find(f => f.id === 'f-1')
    expect((f1?.rawPatches?.[0] as { findingId: string }).findingId).toBe('f-1')
  })
})
