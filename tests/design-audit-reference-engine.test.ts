import { describe, it, expect } from 'vitest'
import { runRedesignCore } from '../src/design/audit/reference/engine/core.js'
import { buildDefaultDeps } from '../src/design/audit/reference/engine/wiring.js'
import { resolveReferenceConfig } from '../src/design/audit/reference/config.js'
import { HashEmbeddingProvider } from '../src/design/audit/reference/retrieval/embedding-hash.js'
import { retrieve } from '../src/design/audit/reference/retrieval/matcher.js'
import { rankDirections } from '../src/design/audit/reference/judge/rank.js'
import { DIMENSIONS } from '../src/design/audit/score-types.js'
import type {
  ReferenceEngineDeps,
  RedesignCoreInput,
  DesignDnaExtractor,
  CorpusReader,
  RedesignGenerator,
  RedesignDirection,
  RetrievalResult,
  TasteJudge,
  RawVerdict,
  Exemplar,
  DesignDNA,
  DesignTokens,
  MeasurementBundle,
  PageClassification,
  PageType,
  ReferenceContext,
} from '../src/design/audit/reference/contracts.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

const makeDNA = (url: string): DesignDNA => ({
  url,
  capturedAt: '2026-01-01T00:00:00.000Z',
  type: {
    steps: [{ fontSizePx: 16, weight: 400, lineHeight: 1.5, family: 'Inter', role: 'body' }],
    ratio: 1.25,
    families: [{ family: 'Inter', role: 'body', weights: [400] }],
  },
  color: {
    roles: {
      primary: ['#1a73e8'],
      secondary: [],
      accent: [],
      neutral: ['#333333'],
      background: ['#ffffff'],
      border: [],
    },
  },
  spacing: { baseUnit: 8, steps: [8, 16, 24], density: 'balanced' },
  radii: { steps: [4, 8] },
  motion: { durationsMs: [200], easings: ['ease'], libraries: [] },
  layout: { density: 'balanced', archetype: 'content-flow' },
  components: { buttons: 2, inputs: 1, cards: 3, nav: 1 },
})

const makeExemplar = (id: string, pageType: PageType): Exemplar => ({
  id,
  source: 'manual',
  url: `https://example.com/${id}`,
  pageType,
  jobToBeDone: 'convert a visitor to signup',
  dna: makeDNA(`https://example.com/${id}`),
  screenshotPath: `${id}.png`,
  aestheticVector: [1, 0, 0],
  eloRating: 1500,
})

const makeDirection = (id: string, grounded: string[]): RedesignDirection => ({
  id,
  name: `Direction ${id}`,
  rationale: 'fits the job-to-be-done',
  asciiLayout: '[hero]\n[feature-grid]',
  typeSystem: { families: ['Inter'], scalePx: [16, 20, 28], ratio: 1.25, rationale: 'clean modular scale' },
  colorSystem: {
    primary: '#1a73e8',
    accent: '#ff5722',
    neutrals: ['#333333', '#666666'],
    background: '#ffffff',
    rationale: 'calm, high-contrast',
  },
  motionSpec: { durationsMs: [200], easings: ['ease'], cues: ['fade in hero'] },
  hierarchy: ['headline', 'primary CTA', 'feature grid'],
  copy: [{ location: 'hero h1', before: 'Old headline', after: 'New headline' }],
  groundedInExemplarIds: grounded.length ? [grounded[0]] : [],
})

const classification: PageClassification = {
  type: 'marketing',
  domain: 'saas',
  framework: null,
  designSystem: 'tailwind-custom',
  maturity: 'shipped',
  intent: 'convert a visitor into a signup',
  confidence: 0.9,
}

const measurements: MeasurementBundle = {
  contrast: {
    totalChecked: 10,
    aaFailures: [
      {
        selector: '.muted',
        text: 'subtle text',
        color: '#777777',
        background: '#ffffff',
        ratio: 3.1,
        required: 4.5,
        fontSize: 14,
        isLargeText: false,
      },
    ],
    aaaFailures: [],
    summary: { aaPassRate: 0.9, aaaPassRate: 0.8 },
  },
  a11y: { ran: true, violations: [], passes: 20 },
  hasBlockingIssues: false,
}

/** A judge favouring a fixed id set: page beats exemplars, direction-1 beats peers. */
function makeJudge(favoured: Set<string>, tokens = 5): TasteJudge {
  return {
    id: 'fake-judge',
    async compare(input): Promise<RawVerdict> {
      const aFav = favoured.has(input.a.id)
      const bFav = favoured.has(input.b.id)
      const base = (slot: RawVerdict['winnerSlot'], confidence: number): RawVerdict => ({
        winnerSlot: slot,
        confidence,
        reasons: ['stub'],
        tokensUsed: tokens,
        ...(input.dimension ? { dimension: input.dimension } : {}),
      })
      if (aFav && !bFav) return base('A', 0.9)
      if (bFav && !aFav) return base('B', 0.9)
      return base('tie', 0.2)
    },
  }
}

interface BuiltDeps {
  deps: ReferenceEngineDeps
  loadCalls: () => number
}

function buildFakeDeps(corpus: Exemplar[], favoured: Set<string>): BuiltDeps {
  let loadCalls = 0
  const extractor: DesignDnaExtractor = {
    async extract(opts) {
      return {
        dna: makeDNA(opts.url),
        tokens: {} as unknown as DesignTokens,
        screenshotPaths: {},
        outputDir: '/tmp/ref',
      }
    },
  }
  const store: CorpusReader = {
    async load() {
      loadCalls++
      return corpus
    },
    async get() {
      return null
    },
    resolveScreenshot(e) {
      return `/abs/${e.screenshotPath}`
    },
  }
  const generator: RedesignGenerator = {
    async generate(_ctx, exemplars, opts) {
      const ids = exemplars.map((e: RetrievalResult) => e.exemplar.id)
      const count = opts?.count ?? exemplars.length
      const all = [
        makeDirection('direction-1', ids),
        makeDirection('direction-2', ids),
        makeDirection('direction-3', ids),
      ]
      return all.slice(0, count)
    },
  }
  const deps: ReferenceEngineDeps = {
    extractor,
    store,
    embedder: HashEmbeddingProvider,
    matcher: { retrieve },
    generator,
    judge: makeJudge(favoured),
    ranker: { rank: rankDirections },
  }
  return { deps, loadCalls: () => loadCalls }
}

const baseInput = (over: Partial<RedesignCoreInput> = {}): RedesignCoreInput => ({
  url: 'https://target.example',
  classification,
  measurements,
  corpus: [makeExemplar('ex-1', 'marketing'), makeExemplar('ex-2', 'marketing')],
  config: resolveReferenceConfig({ corpusDir: '/tmp/corpus', k: 2 }),
  ...over,
})

// ── engine/core orchestration ─────────────────────────────────────────────────

describe('runRedesignCore', () => {
  it('sequences extract→retrieve→generate→judge→rank→score→artifact into a RedesignRunResult', async () => {
    const { deps, loadCalls } = buildFakeDeps(baseInput().corpus, new Set(['page', 'direction-1']))
    const result = await runRedesignCore(deps, baseInput())

    // required RedesignRunResult fields
    expect(result.artifact.url).toBe('https://target.example')
    expect(result.classification).toBe(classification)
    expect(result.measurements).toBe(measurements)
    expect(Object.keys(result.dimensionScores).sort()).toEqual([...DIMENSIONS].sort())

    // page wins every quality comparison ⇒ win-rate 1 ⇒ headline 10 (no blocking cap)
    expect(result.quality.overallWinRate).toBe(1)
    expect(result.headlineScore).toBe(10)

    // direction-1 is favoured ⇒ ranked winner ⇒ artifact ordered winner-first
    expect(result.artifact.ranking.winnerId).toBe('direction-1')
    expect(result.artifact.directions[0].id).toBe('direction-1')

    // acquire-once: the core retrieves the pre-loaded corpus, never store.load()
    expect(loadCalls()).toBe(0)

    // judge tokens accumulated through the wrapped judge boundary
    expect(result.tokensUsed).toBeGreaterThan(0)
  })

  it('emits exactly one measured contrast finding (parity with v1 measurementsToFindings)', async () => {
    const { deps } = buildFakeDeps(baseInput().corpus, new Set(['page', 'direction-1']))
    const result = await runRedesignCore(deps, baseInput())
    const contrast = result.findings.filter((f) => f.category === 'contrast')
    expect(contrast).toHaveLength(1)
    // contrast/a11y stay measured; directional findings are advisory (minor)
    expect(result.findings.some((f) => f.category === 'typography' && f.severity === 'minor')).toBe(true)
  })

  it('caps the headline when measurements flag blocking issues', async () => {
    const { deps } = buildFakeDeps(baseInput().corpus, new Set(['page', 'direction-1']))
    const blocking: MeasurementBundle = { ...measurements, hasBlockingIssues: true }
    const result = await runRedesignCore(deps, baseInput({ measurements: blocking }))
    expect(result.quality.overallWinRate).toBe(1)
    expect(result.headlineScore).toBeLessThanOrEqual(6)
  })

  it('aborts fail-closed when there is nothing to ground against (empty corpus, no reference)', async () => {
    const { deps } = buildFakeDeps([], new Set(['page', 'direction-1']))
    await expect(runRedesignCore(deps, baseInput({ corpus: [] }))).rejects.toThrow(/corpus is empty/)
  })

  it('runs reference-only (empty corpus) by grounding in the synthetic reference hit', async () => {
    const reference: ReferenceContext = {
      kind: 'url',
      dna: makeDNA('https://reference.example'),
      summary: 'world-class reference summary',
    }
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus', k: 2, reference })
    const { deps } = buildFakeDeps([], new Set(['page', 'direction-1']))
    const result = await runRedesignCore(deps, baseInput({ corpus: [], config }))

    expect(result.artifact.referenceId).toBe('reference')
    expect(result.artifact.retrieval.some((r) => r.exemplar.id === 'reference')).toBe(true)
    expect(result.artifact.directions[0].groundedInExemplarIds).toContain('reference')
  })

  it('threads the budget: a generous judge budget unlocks per-dimension win-rates', async () => {
    const config = resolveReferenceConfig({
      corpusDir: '/tmp/corpus',
      k: 2,
      budget: { maxJudgeCalls: 400 },
    })
    const favoured = new Set(['page', 'direction-1'])
    const { deps } = buildFakeDeps(baseInput().corpus, favoured)
    const result = await runRedesignCore(deps, baseInput({ config }))
    expect(result.quality.dimensionWinRates).toBeDefined()
    // every requested dimension is genuinely judge-resolved
    expect(Object.keys(result.quality.dimensionWinRates ?? {}).sort()).toEqual([...DIMENSIONS].sort())
  })
})

// ── engine/wiring composition root ──────────────────────────────────────────────

describe('buildDefaultDeps', () => {
  const stubBrain = {
    async complete() {
      return { text: '{}' }
    },
  }

  it('assembles a ReferenceEngineDeps with every boundary populated', () => {
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus' })
    const deps = buildDefaultDeps(stubBrain, config)
    expect(typeof deps.extractor.extract).toBe('function')
    expect(typeof deps.store.load).toBe('function')
    expect(typeof deps.store.get).toBe('function')
    expect(typeof deps.store.resolveScreenshot).toBe('function')
    expect(typeof deps.matcher.retrieve).toBe('function')
    expect(typeof deps.generator.generate).toBe('function')
    expect(typeof deps.ranker.rank).toBe('function')
  })

  it('selects the deterministic hash embedder for the default config', () => {
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus' })
    const deps = buildDefaultDeps(stubBrain, config)
    expect(deps.embedder.id).toBe('hash-v1')
  })

  it('selects the text judge by default', () => {
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus' })
    const deps = buildDefaultDeps(stubBrain, config)
    expect(deps.judge.id).toBe('text-judge')
  })

  it('builds the screenshot-grounded vision judge from the default visionModels', () => {
    // Brain construction is lazy (no network on ctor), so the composition root
    // assembles the vision ensemble without a live model.
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus', judge: 'vision' })
    const deps = buildDefaultDeps(stubBrain, config)
    expect(deps.judge.id).toBe('vision-judge[openai:gpt-5.4]')
  })

  it('fails closed when judge is vision but visionModels is empty', () => {
    const config = resolveReferenceConfig({ corpusDir: '/tmp/corpus', judge: 'vision', visionModels: [] })
    expect(() => buildDefaultDeps(stubBrain, config)).toThrow(/at least one visionModels ref/)
  })
})
