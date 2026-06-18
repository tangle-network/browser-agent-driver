import { describe, it, expect } from 'vitest'
import { evaluateReferenceGrounded } from '../src/design/audit/reference/index.js'
import { resolveReferenceConfig } from '../src/design/audit/reference/config.js'
import { HashEmbeddingProvider } from '../src/design/audit/reference/retrieval/embedding-hash.js'
import { retrieve } from '../src/design/audit/reference/retrieval/matcher.js'
import { rankDirections } from '../src/design/audit/reference/judge/rank.js'
import { buildAuditResult } from '../src/design/audit/build-result.js'
import { DIMENSIONS } from '../src/design/audit/score-types.js'
import type { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types.js'
import type { ComposedRubric } from '../src/design/audit/types.js'
import type { EnsembleClassification } from '../src/design/audit/score-types.js'
import type {
  ReferenceEngineDeps,
  ReferenceBrain,
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
} from '../src/design/audit/reference/contracts.js'

// ── deterministic fakes (no browser, no live LLM, no disk) ───────────────────

const makeDNA = (url: string): DesignDNA => ({
  url,
  capturedAt: '2026-01-01T00:00:00.000Z',
  type: {
    steps: [{ fontSizePx: 16, weight: 400, lineHeight: 1.5, family: 'Inter', role: 'body' }],
    ratio: 1.25,
    families: [{ family: 'Inter', role: 'body', weights: [400] }],
  },
  color: {
    roles: { primary: ['#1a73e8'], secondary: [], accent: [], neutral: ['#333'], background: ['#fff'], border: [] },
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
  colorSystem: { primary: '#1a73e8', accent: '#ff5722', neutrals: ['#333', '#666'], background: '#fff', rationale: 'calm' },
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
  contrast: { totalChecked: 10, aaFailures: [], aaaFailures: [], summary: { aaPassRate: 1, aaaPassRate: 1 } },
  a11y: { ran: true, violations: [], passes: 20 },
  hasBlockingIssues: false,
}

/** Page beats every exemplar ⇒ win-rate 1 ⇒ headline 10. direction-1 wins its peers. */
function makeJudge(favoured: Set<string>): TasteJudge {
  return {
    id: 'fake-judge',
    async compare(input): Promise<RawVerdict> {
      const aFav = favoured.has(input.a.id)
      const bFav = favoured.has(input.b.id)
      const base = (slot: RawVerdict['winnerSlot']): RawVerdict => ({
        winnerSlot: slot,
        confidence: 0.9,
        reasons: ['stub'],
        tokensUsed: 5,
        ...(input.dimension ? { dimension: input.dimension } : {}),
      })
      if (aFav && !bFav) return base('A')
      if (bFav && !aFav) return base('B')
      return base('tie')
    },
  }
}

function buildFakeDeps(corpus: Exemplar[], favoured: Set<string>): ReferenceEngineDeps {
  const extractor: DesignDnaExtractor = {
    async extract(opts) {
      return { dna: makeDNA(opts.url), tokens: {} as unknown as DesignTokens, screenshotPaths: {}, outputDir: '/tmp/ref' }
    },
  }
  const store: CorpusReader = {
    async load() {
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
      return [makeDirection('direction-1', ids), makeDirection('direction-2', ids), makeDirection('direction-3', ids)].slice(0, count)
    },
  }
  return {
    extractor,
    store,
    embedder: HashEmbeddingProvider,
    matcher: { retrieve },
    generator,
    judge: makeJudge(favoured),
    ranker: { rank: rankDirections },
  }
}

// The `brain` arg is unused once `deps` is injected (buildDefaultDeps is bypassed).
const stubBrain = { async complete() { return { text: '{}' } } } as unknown as ReferenceBrain

const corpus = [makeExemplar('ex-1', 'marketing'), makeExemplar('ex-2', 'marketing')]

// ── stage-6 → stage-8 wiring ─────────────────────────────────────────────────

describe('evaluateReferenceGrounded — stage-6 entrypoint', () => {
  it('returns the PageAuditResult AND the engine dimensionScores for stage 8', async () => {
    const deps = buildFakeDeps(corpus, new Set(['page', 'direction-1']))
    const evaluation = await evaluateReferenceGrounded(
      stubBrain,
      { url: 'https://target.example', classification, measurements, corpus, config: resolveReferenceConfig({ corpusDir: '/tmp/corpus', k: 2 }) },
      deps,
    )

    // The single scoring authority: the reported page score IS the headline.
    expect(evaluation.result.score).toBe(10)
    // dimensionScores surfaced, covering all 5 product dimensions.
    expect(Object.keys(evaluation.dimensionScores).sort()).toEqual([...DIMENSIONS].sort())
    // Default budget never affords the per-dimension leg ⇒ every dim is an
    // honest unassessed placeholder, yet the reported score still tracks the
    // headline (the deflation bug would have pinned result.score near 5).
    for (const dim of DIMENSIONS) expect(evaluation.dimensionScores[dim].confidence).toBe('low')
    expect(evaluation.result.score).toBe(10)
    // The rich artifact is threaded out (not discarded) so the CLI can render the
    // full redesign brief — winner-first, with at least one named direction.
    expect(evaluation.artifact.url).toBe('https://target.example')
    expect(evaluation.artifact.directions.length).toBeGreaterThan(0)
    expect(evaluation.artifact.directions[0].id).toBe(evaluation.artifact.ranking.winnerId)
  })
})

// ── stage-8 single authority: precomputedScores skips brain.auditDesign ──────

function fakeRubric(): ComposedRubric {
  return { fragments: [], body: 'TEST RUBRIC BODY', calibration: 'Score honestly.', dimensions: [] }
}

function fakeEnsemble(): EnsembleClassification {
  return {
    type: 'marketing',
    domain: 'saas',
    framework: null,
    designSystem: 'tailwind-custom',
    maturity: 'shipped',
    intent: 'convert',
    confidence: 0.8,
    signals: [
      { source: 'url-pattern', type: 'marketing', confidence: 0.7, rationale: 'fixture' },
      { source: 'dom-heuristic', type: 'marketing', confidence: 0.7, rationale: 'fixture' },
    ],
    signalsAgreed: true,
    ensembleConfidence: 0.8,
    firstPrinciplesMode: false,
  }
}

describe('reference mode wiring: engine dimensionScores → stage-8 precomputedScores', () => {
  it('does NOT call brain.auditDesign when the engine dimensionScores are passed as precomputedScores', async () => {
    const deps = buildFakeDeps(corpus, new Set(['page', 'direction-1']))
    const evaluation = await evaluateReferenceGrounded(
      stubBrain,
      { url: 'https://target.example', classification, measurements, corpus, config: resolveReferenceConfig({ corpusDir: '/tmp/corpus', k: 2 }) },
      deps,
    )

    let auditDesignCalls = 0
    const spyBrain = {
      auditDesign: async () => {
        auditDesignCalls++
        throw new Error('brain.auditDesign must not run in reference mode (stage 8 has precomputedScores)')
      },
    } as unknown as Brain
    const state = { url: 'https://target.example', title: 't', snapshot: '', screenshot: '' } as PageState

    const auditResult = await buildAuditResult({
      brain: spyBrain,
      state,
      pageRef: 'https://target.example',
      ensemble: fakeEnsemble(),
      rubric: fakeRubric(),
      measurements,
      v1Result: evaluation.result,
      precomputedScores: evaluation.dimensionScores,
    })

    // The redundant second scoring LLM call is eliminated…
    expect(auditDesignCalls).toBe(0)
    // …and the engine's scores ARE the rollup's source (one scoring authority).
    expect(auditResult.scores).toBe(evaluation.dimensionScores)
    expect(Object.keys(auditResult.scores).sort()).toEqual([...DIMENSIONS].sort())
  })
})
