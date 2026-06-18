import { describe, it, expect } from 'vitest'
import { aestheticDescriptor, structuralFeatures } from '../src/design/audit/reference/dna/descriptor.js'
import { dnaDelta } from '../src/design/audit/reference/dna/delta.js'
import {
  HashEmbeddingProvider,
  HASH_EMBEDDING_DIMS,
  cosineSimilarity,
} from '../src/design/audit/reference/retrieval/embedding-hash.js'
import { resolveEmbeddingProvider, OpenAiEmbeddingProvider } from '../src/design/audit/reference/retrieval/embedding-openai.js'
import { retrieve, scoreExemplar } from '../src/design/audit/reference/retrieval/matcher.js'
import type {
  DesignDNA,
  ColorRole,
  Exemplar,
  CorpusQuery,
  PageType,
  RetrieveWeights,
} from '../src/design/audit/reference/contracts.js'

// ── DNA fixture builder (no IO, no LLM, no browser) ──────────────────────────

const emptyRoles = (): Record<ColorRole, string[]> => ({
  primary: [],
  secondary: [],
  accent: [],
  neutral: [],
  background: [],
  border: [],
})

function makeDNA(over: Partial<DesignDNA> = {}): DesignDNA {
  const base: DesignDNA = {
    url: 'https://example.com',
    capturedAt: '2026-01-01T00:00:00.000Z',
    type: {
      steps: [
        { fontSizePx: 16, weight: 400, lineHeight: 1.5, family: 'Inter', role: 'body' },
        { fontSizePx: 20, weight: 700, lineHeight: 1.4, family: 'Inter', role: 'heading' },
        { fontSizePx: 25, weight: 700, lineHeight: 1.3, family: 'Inter', role: 'heading' },
      ],
      ratio: 1.25,
      families: [{ family: 'Inter', role: 'body', weights: [400, 700] }],
    },
    color: {
      roles: { ...emptyRoles(), primary: ['#2563eb'], neutral: ['#111827'], background: ['#ffffff'] },
      contrastFloor: undefined,
    },
    spacing: { baseUnit: 8, steps: [8, 16, 24], density: 'sparse' },
    radii: { steps: [4, 8] },
    motion: { durationsMs: [200], easings: ['ease'], libraries: [] },
    layout: { columns: undefined, gridBaseUnit: 8, whitespaceRatio: undefined, density: 'sparse', archetype: 'card-grid' },
    components: { buttons: 1, inputs: 0, cards: 3, nav: 1 },
    signals: undefined,
  }
  return { ...base, ...over }
}

// ── aestheticDescriptor ──────────────────────────────────────────────────────

describe('aestheticDescriptor', () => {
  it('is deterministic and renders qualitative aesthetic tokens (not a numeric dump)', () => {
    const dna = makeDNA()
    const a = aestheticDescriptor(dna)
    const b = aestheticDescriptor(dna)
    expect(a).toBe(b)
    expect(a).toContain('sparse density, card-grid archetype')
    expect(a).toContain('3-step modular scale ~1.25')
    expect(a).toContain('cool') // #2563eb is blue-led
    expect(a).toContain('snappy motion ~200ms')
    // distinct from summarizeDNA: no raw px-list spec leakage
    expect(a).not.toContain('16/20/25')
  })

  it('reflects palette temperature and contrast posture from measured signals', () => {
    const warm = aestheticDescriptor(
      makeDNA({
        color: { roles: { ...emptyRoles(), primary: ['#cc2222'] }, contrastFloor: 3.1 },
      }),
    )
    expect(warm).toContain('warm')
    expect(warm).toContain('low-contrast')
  })

  it('respects the maxChars budget', () => {
    const clipped = aestheticDescriptor(makeDNA(), { maxChars: 40 })
    expect(clipped.length).toBeLessThanOrEqual(40)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

// ── structuralFeatures ───────────────────────────────────────────────────────

describe('structuralFeatures', () => {
  it('is fixed-length, order-stable and identical across calls', () => {
    const dna = makeDNA()
    const v1 = structuralFeatures(dna)
    const v2 = structuralFeatures(dna)
    expect(v1).toEqual(v2)
    expect(v1.length).toBe(16)
    expect(structuralFeatures(makeDNA({ components: { buttons: 9, inputs: 9, cards: 9, nav: 9 } })).length).toBe(16)
  })

  it('keeps every component bounded in [0, 1]', () => {
    const v = structuralFeatures(
      makeDNA({
        type: { steps: makeDNA().type.steps, ratio: 1.9, families: [] },
        radii: { steps: [9999] },
        color: { roles: emptyRoles(), contrastFloor: 30 },
      }),
    )
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
    }
  })

  it('moves the density/ratio slots when the design changes', () => {
    const sparse = structuralFeatures(makeDNA({ spacing: { baseUnit: 8, steps: [8], density: 'sparse' } }))
    const dense = structuralFeatures(makeDNA({ spacing: { baseUnit: 8, steps: [8], density: 'dense' } }))
    expect(sparse[7]).toBe(0) // density slot
    expect(dense[7]).toBe(1)
  })
})

// ── dnaDelta ─────────────────────────────────────────────────────────────────

describe('dnaDelta', () => {
  it('reports an empty delta with a stable summary for an identical pair', () => {
    const dna = makeDNA()
    const delta = dnaDelta(dna, dna)
    expect(delta.color).toEqual({ added: [], removed: [], changed: [] })
    expect(delta.type.stepsAdded).toBe(0)
    expect(delta.type.stepsRemoved).toBe(0)
    expect(delta.type.ratioDelta).toBeUndefined()
    expect(delta.spacing.densityChanged).toBe(false)
    expect(delta.components).toEqual({ buttons: 0, inputs: 0, cards: 0, nav: 0 })
    expect(delta.summary).toBe('no structural difference')
  })

  it('classifies colour roles as added / removed / changed', () => {
    const current = makeDNA({ color: { roles: { ...emptyRoles(), primary: ['#2563eb'], neutral: ['#111827'] }, contrastFloor: undefined } })
    const target = makeDNA({ color: { roles: { ...emptyRoles(), primary: ['#0a0aff'], accent: ['#22c55e'] }, contrastFloor: undefined } })
    const delta = dnaDelta(current, target)
    expect(delta.color.added).toEqual(['accent']) // target introduces accent
    expect(delta.color.removed).toEqual(['neutral']) // current drops neutral
    expect(delta.color.changed).toEqual(['primary']) // same role, different hex
  })

  it('captures type-scale step deltas, a ratio shift, and signed component deltas', () => {
    const current = makeDNA()
    const target = makeDNA({
      type: {
        steps: [
          { fontSizePx: 16, weight: 400, lineHeight: 1.5, family: 'Inter', role: 'body' },
          { fontSizePx: 32, weight: 700, lineHeight: 1.2, family: 'Inter', role: 'heading' },
        ],
        ratio: 1.5,
        families: [],
      },
      spacing: { baseUnit: 4, steps: [4, 8], density: 'dense' },
      components: { buttons: 1, inputs: 0, cards: 1, nav: 1 },
    })
    const delta = dnaDelta(current, target)
    expect(delta.type.stepsAdded).toBe(1) // 32 is new in target
    expect(delta.type.stepsRemoved).toBe(2) // 20, 25 dropped
    expect(delta.type.ratioDelta).toBe(0.25)
    expect(delta.spacing.baseUnitFrom).toBe(8)
    expect(delta.spacing.baseUnitTo).toBe(4)
    expect(delta.spacing.densityChanged).toBe(true)
    expect(delta.components.cards).toBe(-2) // target has 2 fewer card patterns
    expect(delta.summary).toContain('grid 8→4px')
    expect(delta.summary).toContain('cards -2')
  })
})

// ── HashEmbeddingProvider + cosineSimilarity ─────────────────────────────────

describe('HashEmbeddingProvider', () => {
  it('is deterministic, fixed-dimension and unit-normalised', async () => {
    const [v1] = await HashEmbeddingProvider.embed(['sparse minimal editorial layout'])
    const [v2] = await HashEmbeddingProvider.embed(['sparse minimal editorial layout'])
    expect(v1).toEqual(v2)
    expect(v1.length).toBe(HASH_EMBEDDING_DIMS)
    const norm = Math.sqrt(v1.reduce((a, x) => a + x * x, 0))
    expect(norm).toBeCloseTo(1, 10)
    expect(HashEmbeddingProvider.id).toBe('hash-v1')
  })

  it('embeds a batch positionally and returns a zero vector for empty text', async () => {
    const [a, empty, b] = await HashEmbeddingProvider.embed(['dense dashboard', '', 'dense dashboard'])
    expect(a).toEqual(b)
    expect(empty.every((x) => x === 0)).toBe(true)
  })

  it('cosine is symmetric, self-similar, and bounded; 0 against a zero vector', () => {
    const a = [1, 2, 3, 4]
    const b = [4, 3, 2, 1]
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 12)
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 12)
    expect(cosineSimilarity(a, b)).toBeGreaterThanOrEqual(-1)
    expect(cosineSimilarity(a, b)).toBeLessThanOrEqual(1)
    expect(cosineSimilarity(a, [0, 0, 0, 0])).toBe(0)
  })

  it('ranks similar descriptors above dissimilar ones', async () => {
    const [q, near, far] = await HashEmbeddingProvider.embed([
      'sparse minimal editorial calm layout',
      'sparse minimal editorial calm hero',
      'dense control room data table grid heavy',
    ])
    expect(cosineSimilarity(q, near)).toBeGreaterThan(cosineSimilarity(q, far))
  })
})

// ── resolveEmbeddingProvider (no live network) ───────────────────────────────

describe('resolveEmbeddingProvider', () => {
  it('falls back to the deterministic hash provider when no key is present', () => {
    const provider = resolveEmbeddingProvider({ env: {} })
    expect(provider).toBe(HashEmbeddingProvider)
    expect(provider.id).toBe('hash-v1')
  })

  it('selects an OpenAI provider (env-bound instance) when a key is resolvable via an explicit env', () => {
    // An explicit env override yields a fresh env-bound provider, NOT the
    // process-env singleton — returning the singleton would silently ignore the override.
    const provider = resolveEmbeddingProvider({ env: { OPENAI_API_KEY: 'sk-test' } })
    expect(provider.id).toBe('openai:text-embedding-3-small')
    expect(provider).not.toBe(HashEmbeddingProvider)
  })

  it('returns the shared OpenAiEmbeddingProvider singleton on the default process-env path', () => {
    const saved = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test'
    try {
      expect(resolveEmbeddingProvider()).toBe(OpenAiEmbeddingProvider)
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
  })

  it('builds a model-specific OpenAI provider when a model override is given', () => {
    const provider = resolveEmbeddingProvider({ env: { OPENAI_API_KEY: 'sk-test' }, model: 'text-embedding-3-large' })
    expect(provider.id).toBe('openai:text-embedding-3-large')
  })
})

// ── retrieve / scoreExemplar ─────────────────────────────────────────────────

// A 6-bucket aesthetic space: one-hot-ish unit vectors so cosine is exact.
const dim = 6
const oneHot = (i: number): number[] => Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0))

function makeExemplar(over: Partial<Exemplar> & Pick<Exemplar, 'id' | 'pageType' | 'aestheticVector'>): Exemplar {
  return {
    source: 'manual',
    url: `https://exemplar/${over.id}`,
    jobToBeDone: 'convert a visitor',
    dna: makeDNA(),
    screenshotPath: `shots/${over.id}.png`,
    eloRating: 1500,
    ...over,
  }
}

const corpus: Exemplar[] = [
  makeExemplar({ id: 'mk-near', pageType: 'marketing', aestheticVector: oneHot(0), jobToBeDone: 'convert a visitor to signup' }),
  makeExemplar({ id: 'mk-mid', pageType: 'marketing', aestheticVector: [0.7, 0.7, 0, 0, 0, 0] }),
  makeExemplar({ id: 'mk-far', pageType: 'marketing', aestheticVector: oneHot(3) }),
  makeExemplar({ id: 'dash-1', pageType: 'dashboard', aestheticVector: oneHot(0) }),
  makeExemplar({ id: 'dash-2', pageType: 'dashboard', aestheticVector: oneHot(4) }),
  makeExemplar({ id: 'docs-1', pageType: 'docs', aestheticVector: oneHot(5) }),
]

const baseQuery = (over: Partial<CorpusQuery> = {}): CorpusQuery => ({
  pageType: 'marketing',
  jobToBeDone: 'convert a visitor to signup',
  aestheticVector: oneHot(0),
  ...over,
})

describe('retrieve', () => {
  it('hard-filters by pageType and ranks nearest-by-aesthetic-vector first', () => {
    const results = retrieve(baseQuery(), corpus)
    // only marketing candidates survive the hard filter
    expect(results.map((r) => r.exemplar.pageType)).toEqual(['marketing', 'marketing', 'marketing'])
    expect(results[0].exemplar.id).toBe('mk-near')
    expect(results[0].score).toBeGreaterThan(results[1].score)
    expect(results[1].score).toBeGreaterThan(results[2].score)
    expect(results[0].reasons[0]).toBe('page-type match: marketing')
  })

  it('resolves a NOVEL pageType to the nearest neighbour across the whole corpus', () => {
    const results = retrieve(baseQuery({ pageType: 'social' as PageType }), corpus)
    // no 'social' exemplar exists → full corpus is ranked, nearest vector wins
    expect(results.length).toBe(corpus.length)
    expect(results[0].exemplar.aestheticVector).toEqual(oneHot(0))
    expect(results[0].reasons[0]).toContain('nearest-neighbour fallback')
    expect(results[0].reasons[0]).toContain("no 'social'")
  })

  it('breaks score ties by eloRating, then by id', () => {
    const tied: Exemplar[] = [
      makeExemplar({ id: 'b-low', pageType: 'tool', aestheticVector: oneHot(0), eloRating: 1500 }),
      makeExemplar({ id: 'a-high', pageType: 'tool', aestheticVector: oneHot(0), eloRating: 1800 }),
      makeExemplar({ id: 'c-low', pageType: 'tool', aestheticVector: oneHot(0), eloRating: 1500 }),
    ]
    const results = retrieve(baseQuery({ pageType: 'tool' }), tied)
    // identical vectors + identical job → identical score; elo desc then id asc
    expect(results.map((r) => r.exemplar.id)).toEqual(['a-high', 'b-low', 'c-low'])
  })

  it('returns an empty list for an empty corpus (never fabricates)', () => {
    expect(retrieve(baseQuery(), [])).toEqual([])
  })

  it('blends a structural signal when the query carries a structuralVector', () => {
    const structurallyClose = makeDNA({ components: { buttons: 1, inputs: 0, cards: 3, nav: 1 } })
    const structuralVector = structuralFeatures(structurallyClose)
    const q = baseQuery({ structuralVector })
    const result = retrieve(q, corpus)
    expect(result[0].reasons.some((r) => r.startsWith('structural similarity'))).toBe(true)
  })
})

describe('scoreExemplar', () => {
  it('returns a [0, 1] blend, peaking at 1 for an identical aesthetic + job', () => {
    const e = makeExemplar({ id: 'self', pageType: 'marketing', aestheticVector: oneHot(0), jobToBeDone: 'convert a visitor to signup' })
    const score = scoreExemplar(baseQuery(), e)
    expect(score).toBeGreaterThan(0.99)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('weights aesthetic above job: a closer vector outranks a closer job string', () => {
    const weights: RetrieveWeights = { aesthetic: 0.8, structural: 0, job: 0.2 }
    const vectorMatch = makeExemplar({ id: 'v', pageType: 'marketing', aestheticVector: oneHot(0), jobToBeDone: 'unrelated text here' })
    const jobMatch = makeExemplar({ id: 'j', pageType: 'marketing', aestheticVector: oneHot(2), jobToBeDone: 'convert a visitor to signup' })
    expect(scoreExemplar(baseQuery(), vectorMatch, weights)).toBeGreaterThan(scoreExemplar(baseQuery(), jobMatch, weights))
  })
})
