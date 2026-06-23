import { describe, it, expect, vi } from 'vitest'
import { buildDirectionPrompt } from '../src/design/audit/reference/generate/prompt.js'
import { parseDirection, validateGrounding } from '../src/design/audit/reference/generate/parse.js'
import {
  createBrainGenerator,
  type GenerationModel,
} from '../src/design/audit/reference/generate/generator.js'
import type {
  DesignDNA,
  Exemplar,
  GenerationContext,
  RetrievalResult,
  RedesignDirection,
} from '../src/design/audit/reference/contracts.js'
import type { PageClassification, MeasurementBundle } from '../src/design/audit/types.js'

// ── fixtures (no network, no browser, no LLM) ────────────────────────────────

function makeDNA(over: Partial<DesignDNA> = {}): DesignDNA {
  return {
    url: 'https://app.example/dashboard',
    capturedAt: '2026-01-01T00:00:00.000Z',
    type: {
      steps: [{ fontSizePx: 14, weight: 400, lineHeight: 1.5, family: 'Inter', role: 'body' }],
      ratio: 1.25,
      families: [{ family: 'Inter', role: 'body', weights: [400, 600] }],
    },
    color: {
      roles: {
        primary: ['#2563eb'],
        secondary: [],
        accent: [],
        neutral: ['#111827'],
        background: ['#ffffff'],
        border: ['#e5e7eb'],
      },
      contrastFloor: 4.6,
    },
    spacing: { baseUnit: 8, steps: [8, 16, 24], density: 'balanced' },
    radii: { steps: [4, 8] },
    motion: { durationsMs: [200], easings: ['ease'], libraries: [] },
    layout: { columns: 12, gridBaseUnit: 8, whitespaceRatio: 0.4, density: 'balanced', archetype: 'nav-content' },
    components: { buttons: 2, inputs: 1, cards: 3, nav: 1 },
    signals: { contrastAaPassRate: 0.9, a11yBlockingCount: 1 },
    ...over,
  }
}

const classification: PageClassification = {
  type: 'dashboard',
  domain: 'analytics',
  framework: 'react',
  designSystem: 'tailwind-custom',
  maturity: 'shipped',
  intent: 'let an operator monitor live metrics at a glance',
  confidence: 0.9,
}

function makeMeasurements(): MeasurementBundle {
  return {
    contrast: {
      totalChecked: 100,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 0.94, aaaPassRate: 0.6 },
    },
    a11y: {
      ran: true,
      violations: [
        { id: 'color-contrast', impact: 'serious', description: '', tags: ['wcag2aa'], nodes: [], helpUrl: '' },
      ],
      passes: 40,
    },
    hasBlockingIssues: false,
  }
}

function makeExemplar(id: string, over: Partial<Exemplar> = {}): Exemplar {
  return {
    id,
    source: 'awwwards',
    url: `https://exemplar.example/${id}`,
    pageType: 'dashboard',
    jobToBeDone: 'surface live operational metrics without overwhelming the operator',
    dna: makeDNA({ url: `https://exemplar.example/${id}`, layout: { density: 'sparse', archetype: 'card-grid' } }),
    screenshotPath: `/corpus/${id}.png`,
    aestheticVector: [0.1, 0.2, 0.3],
    eloRating: 1500,
    ...over,
  }
}

function makeHit(id: string, reasons: string[] = ['same page type', 'nearest aesthetic neighbour']): RetrievalResult {
  return { exemplar: makeExemplar(id), score: 0.82, reasons }
}

const ctx: GenerationContext = {
  url: 'https://app.example/dashboard',
  classification,
  dna: makeDNA(),
  measurements: makeMeasurements(),
}

function validDirectionJson(groundedId: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'model-proposed-slug',
    name: 'Editorial Calm',
    rationale: 'A calm, content-first reading surface that mirrors the reference.',
    asciiLayout: '+----------+\n|  header  |\n+----------+\n|  grid    |\n+----------+',
    typeSystem: { families: ['Inter'], scalePx: [14, 18, 24, 32], ratio: 1.25, rationale: 'modular 1.25 scale' },
    colorSystem: {
      primary: '#2563eb',
      accent: '#f59e0b',
      neutrals: ['#111827', '#6b7280'],
      background: '#ffffff',
      rationale: 'high-contrast neutral base',
    },
    motionSpec: { durationsMs: [160, 240], easings: ['ease-out'], cues: ['stagger cards on enter'] },
    hierarchy: ['headline', 'primary CTA', 'metric grid'],
    copy: [
      { location: 'h1', before: 'Dashboard', after: 'Your metrics, live' },
      { location: 'cta', after: 'Get started' },
    ],
    groundedInExemplarIds: [groundedId],
    ...over,
  })
}

// ── buildDirectionPrompt (pure) ──────────────────────────────────────────────

describe('buildDirectionPrompt', () => {
  it('grounds the named exemplar and demands every RedesignDirection field', () => {
    const hit = makeHit('ex-a')
    const { system, user } = buildDirectionPrompt(ctx, hit)

    // exemplar identity is injected and grounding is demanded
    expect(user).toContain('ex-a')
    expect(user).toContain('REFERENCE EXEMPLAR')
    expect(system).toContain('groundedInExemplarIds')
    expect(system.toLowerCase()).toContain('never invent')

    // page-under-audit context present
    expect(user).toContain('PAGE UNDER REDESIGN')
    expect(user).toContain('https://app.example/dashboard')
    expect(user).toContain('let an operator monitor live metrics at a glance')

    // every required artifact field is named in the output contract
    for (const field of [
      'asciiLayout',
      'typeSystem',
      'colorSystem',
      'motionSpec',
      'hierarchy',
      'copy',
      'groundedInExemplarIds',
    ]) {
      expect(user).toContain(field)
    }

    // measured constraints folded in (do-not-regress)
    expect(user).toContain('GROUND-TRUTH CONSTRAINTS')
  })

  it('is byte-stable for fixed inputs', () => {
    const hit = makeHit('ex-a')
    expect(buildDirectionPrompt(ctx, hit)).toEqual(buildDirectionPrompt(ctx, hit))
  })

  it('bounds injected DNA by maxRefChars', () => {
    const hit = makeHit('ex-a')
    const tight = buildDirectionPrompt(ctx, hit, { maxRefChars: 30 })
    const loose = buildDirectionPrompt(ctx, hit, { maxRefChars: 5000 })
    expect(tight.user.length).toBeLessThan(loose.user.length)
    expect(tight.user).toContain('…')
  })

  it('injects the rubric body when present, truncated', () => {
    const hit = makeHit('ex-a')
    const withRubric: GenerationContext = { ...ctx, rubricBody: 'X'.repeat(5000) }
    const { user } = buildDirectionPrompt(ctx, hit)
    const { user: ruled } = buildDirectionPrompt(withRubric, hit)
    expect(user).not.toContain('SCORING CRITERIA')
    expect(ruled).toContain('SCORING CRITERIA')
    expect(ruled).toContain('…')
  })

  // Regression: a sparse page grounded against a dense exemplar must not be told
  // to fabricate content to fill the layout (the example.com failure — invented
  // "Recent Activity" feeds, fake metrics/dates). Fidelity to the page's real
  // content is a hard rule; the exemplar is craft only, never content.
  it('forbids fabricating content the page does not have (content fidelity)', () => {
    const hit = makeHit('ex-a')
    const { system } = buildDirectionPrompt(ctx, hit)
    const sys = system.toLowerCase()
    expect(sys).toContain('never fabricate content')
    expect(sys).toContain("page's own content")
    // sparse pages stay restrained rather than being padded to the exemplar's density
    expect(sys).toContain('proportionally restrained')
    expect(sys).toContain('rather than manufacturing')
    // the exemplar is a source of craft, not content/structure
    expect(sys).toContain('borrow its craft, never its content or structure')
    // do not assert specific values the model was not given
    expect(sys).toContain('do not assert specific values')
  })

  // The job-first reframe: the prompt must lead from the user's task and forbid
  // stripping navigation or density to look prettier — the regression that turned
  // the python docs page into a marketing brochure (lost ToC, lost density).
  it('leads from task fitness and forbids regressing function for aesthetics', () => {
    const hit = makeHit('ex-a')
    const { system } = buildDirectionPrompt(ctx, hit)
    const sys = system.toLowerCase()
    // persona is product designer (task outcomes), not art director (decoration)
    expect(sys).toContain('product designer')
    expect(sys).not.toContain('art director')
    // task first, in priority order
    expect(sys).toContain('task first')
    expect(sys).toContain('priority order')
    // never delete navigation to look cleaner
    expect(sys).toContain('preserve functional affordances')
    expect(sys).toContain('delete navigation')
    // density is value on functional pages; right-size rather than reskin
    expect(sys).toContain('preserve density where it is the value')
    expect(sys).toContain('must not become a landing page')
  })

  // The per-page functional contract is DATA-DRIVEN off measured DNA: it lists the
  // page's nav affordances to preserve, and only asserts "DENSE" when the page is
  // actually measured dense (a sparse page is never forced to stay dense).
  it('injects a data-driven functional contract that preserves nav + real density', () => {
    const denseCtx: GenerationContext = {
      ...ctx,
      dna: makeDNA({
        layout: { columns: 12, gridBaseUnit: 8, whitespaceRatio: 0.2, density: 'dense', archetype: 'nav-content' },
        components: { buttons: 4, inputs: 2, cards: 8, nav: 3 },
      }),
    }
    const { user } = buildDirectionPrompt(denseCtx, makeHit('ex-a'))
    expect(user).toContain('FUNCTIONAL CONTRACT')
    expect(user).toContain('Keep all 3 navigation') // 3 nav affordances detected
    expect(user).toContain('This page is DENSE') // density === 'dense'

    // a sparse page gets the contract + nav line but NOT the dense directive
    const sparseCtx: GenerationContext = {
      ...ctx,
      dna: makeDNA({
        layout: { columns: 1, gridBaseUnit: 8, whitespaceRatio: 0.8, density: 'sparse', archetype: 'hero' },
        components: { buttons: 1, inputs: 0, cards: 0, nav: 0 },
      }),
    }
    const { user: sparseUser } = buildDirectionPrompt(sparseCtx, makeHit('ex-a'))
    expect(sparseUser).toContain('FUNCTIONAL CONTRACT')
    expect(sparseUser).not.toContain('This page is DENSE')
    expect(sparseUser).not.toContain('navigation / wayfinding affordance') // nav === 0
  })
})

// ── parseDirection (pure, fail-closed) ───────────────────────────────────────

describe('parseDirection', () => {
  it('parses a well-formed direction grounded in an allowed exemplar', () => {
    const res = parseDirection(validDirectionJson('ex-a'), ['ex-a', 'ex-b'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.direction.name).toBe('Editorial Calm')
    expect(res.direction.typeSystem.scalePx).toEqual([14, 18, 24, 32])
    expect(res.direction.colorSystem.accent).toBe('#f59e0b')
    expect(res.direction.copy[1]).toEqual({ location: 'cta', after: 'Get started' })
    expect(res.direction.groundedInExemplarIds).toEqual(['ex-a'])
  })

  it('coerces numeric STRINGS in typeSystem.ratio/scalePx and motionSpec.durationsMs', () => {
    // Models (esp. non-OpenAI ones, e.g. GLM-5.2) often emit numbers as strings.
    const json = validDirectionJson('ex-a', {
      typeSystem: { families: ['Inter'], scalePx: ['14', '18', '24'], ratio: '1.25', rationale: 'scale' },
      motionSpec: { durationsMs: ['160', '240'], easings: ['ease-out'], cues: ['x'] },
    })
    const res = parseDirection(json, ['ex-a'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.direction.typeSystem.ratio).toBe(1.25)
    expect(res.direction.typeSystem.scalePx).toEqual([14, 18, 24])
    expect(res.direction.motionSpec.durationsMs).toEqual([160, 240])
  })

  it('tolerates a markdown code fence', () => {
    const res = parseDirection('```json\n' + validDirectionJson('ex-a') + '\n```', ['ex-a'])
    expect(res.ok).toBe(true)
  })

  it('tolerates a prose preamble around the object', () => {
    const res = parseDirection('Here is your direction:\n' + validDirectionJson('ex-a') + '\nDone.', ['ex-a'])
    expect(res.ok).toBe(true)
  })

  it('makes accent and copy.before optional', () => {
    const json = validDirectionJson('ex-a', {
      colorSystem: { primary: '#000', neutrals: ['#111'], background: '#fff', rationale: 'mono' },
      copy: [{ location: 'h1', after: 'New headline' }],
    })
    const res = parseDirection(json, ['ex-a'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.direction.colorSystem.accent).toBeUndefined()
    expect(res.direction.copy[0].before).toBeUndefined()
  })

  it('fails closed on non-JSON garbage', () => {
    const res = parseDirection('the model refused to answer', ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/no JSON object/i)
  })

  it('fails closed on truncated JSON with no closing brace, reporting truncation', () => {
    const truncated = validDirectionJson('ex-a').slice(0, 120)
    const res = parseDirection(truncated, ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    // An opened-but-unclosed object is a truncated completion, not "no JSON" —
    // surface that so a reasoning model hitting the token cap is diagnosable.
    expect(res.reason).toMatch(/truncated/i)
  })

  it('reports empty output distinctly from non-JSON garbage', () => {
    const res = parseDirection('   ', ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/empty/i)
  })

  it('fails closed on a braced-but-unparseable object', () => {
    const broken = validDirectionJson('ex-a').slice(0, 120) + '}'
    const res = parseDirection(broken, ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/invalid JSON/i)
  })

  it('fails closed when a required nested field is missing', () => {
    const json = validDirectionJson('ex-a', { typeSystem: { families: ['Inter'], ratio: 1.25, rationale: 'x' } })
    const res = parseDirection(json, ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/typeSystem\.scalePx/)
  })

  it('rejects a hallucinated exemplar id (never fabricates a direction)', () => {
    const res = parseDirection(validDirectionJson('ex-ZZZ'), ['ex-a', 'ex-b'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/unknown exemplar ids: ex-ZZZ/)
  })

  it('rejects an ungrounded direction (empty groundedInExemplarIds)', () => {
    const res = parseDirection(validDirectionJson('ex-a', { groundedInExemplarIds: [] }), ['ex-a'])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/ungrounded/i)
  })

  it('does not leak extra keys or pollute Object.prototype on hostile input', () => {
    const hostile = validDirectionJson('ex-a', { evil: 'leak', __proto__: { polluted: true } })
    const res = parseDirection(hostile, ['ex-a'])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect((res.direction as Record<string, unknown>).evil).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('validateGrounding surfaces only the offending ids', () => {
    const direction = {
      groundedInExemplarIds: ['ex-a', 'ex-x', 'ex-y'],
    } as RedesignDirection
    expect(validateGrounding(direction, ['ex-a', 'ex-b'])).toEqual(['ex-x', 'ex-y'])
    expect(validateGrounding(direction, ['ex-a', 'ex-x', 'ex-y'])).toEqual([])
  })
})

// ── createBrainGenerator (adapter, injected mock model) ──────────────────────

// Each mocked call reports a fixed token cost so a test can assert the generator
// sums tokens across every completed call (parsed or not).
const TOKENS_PER_CALL = 7

function mockModel(responder: (user: string) => string | Promise<string>): GenerationModel & {
  calls: Array<{ system: string; user: string }>
} {
  const calls: Array<{ system: string; user: string }> = []
  return {
    calls,
    async complete(system: string, user: string) {
      calls.push({ system, user })
      return { text: await responder(user), tokensUsed: TOKENS_PER_CALL }
    },
  }
}

// Echo back the one exemplar id that appears in the prompt so grounding passes.
const idFor = (user: string, ids: string[]): string => ids.find((id) => user.includes(id)) ?? ids[0]

describe('createBrainGenerator', () => {
  const ids = ['ex-a', 'ex-b', 'ex-c']
  const exemplars = ids.map((id) => makeHit(id))

  it('fans out one call per direction and returns N grounded directions', async () => {
    const model = mockModel((user) => validDirectionJson(idFor(user, ids)))
    const gen = createBrainGenerator(model)
    const seen: RedesignDirection[] = []

    const { directions, tokensUsed } = await gen.generate(ctx, exemplars, {
      count: 3,
      onDirection: (d) => seen.push(d),
    })

    expect(model.calls).toHaveLength(3)
    expect(directions).toHaveLength(3)
    // every model call's tokens are summed into the pass total
    expect(tokensUsed).toBe(3 * TOKENS_PER_CALL)
    // onDirection streamed once per accepted direction
    expect(seen).toHaveLength(3)
    // ids are normalised to unique, deterministic slot ids
    expect(directions.map((d) => d.id)).toEqual(['direction-1', 'direction-2', 'direction-3'])
    expect(new Set(directions.map((d) => d.id)).size).toBe(3)
    // every direction is grounded only in retrieved exemplars
    for (const d of directions) {
      for (const gid of d.groundedInExemplarIds) expect(ids).toContain(gid)
    }
  })

  it('drops a single malformed call without failing the batch', async () => {
    const model = mockModel((user) =>
      user.includes('ex-b') ? 'the model produced garbage' : validDirectionJson(idFor(user, ids)),
    )
    const gen = createBrainGenerator(model)
    const seen: RedesignDirection[] = []

    const { directions, tokensUsed } = await gen.generate(ctx, exemplars, {
      count: 3,
      onDirection: (d) => seen.push(d),
    })

    expect(model.calls).toHaveLength(3)
    expect(directions).toHaveLength(2)
    expect(seen).toHaveLength(2)
    // a malformed RESPONSE still billed tokens, so all 3 calls count toward cost
    expect(tokensUsed).toBe(3 * TOKENS_PER_CALL)
    // ids stay unique even with a gap at the dropped slot
    expect(new Set(directions.map((d) => d.id)).size).toBe(2)
  })

  it('survives a rejected model call', async () => {
    const model = mockModel((user) => {
      if (user.includes('ex-c')) return Promise.reject(new Error('rate limited'))
      return validDirectionJson(idFor(user, ids))
    })
    const gen = createBrainGenerator(model)
    const { directions, tokensUsed } = await gen.generate(ctx, exemplars, { count: 3 })
    expect(directions).toHaveLength(2)
    // a thrown call reports no tokens; only the 2 completed calls count
    expect(tokensUsed).toBe(2 * TOKENS_PER_CALL)
  })

  it('caps the fan-out at the requested count', async () => {
    const complete = vi.fn(async (_system: string, user: string) => ({ text: validDirectionJson(idFor(user, ids)) }))
    const gen = createBrainGenerator({ complete })
    const { directions } = await gen.generate(ctx, exemplars, { count: 2 })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(directions).toHaveLength(2)
  })

  it('never exceeds the available exemplars and applies the configured output cap', async () => {
    const complete = vi.fn(async (_system: string, user: string) => ({ text: validDirectionJson(idFor(user, ids)) }))
    const gen = createBrainGenerator({ complete }, { maxOutputTokens: 999 })
    // request 10 directions but only 3 exemplars exist
    const { directions } = await gen.generate(ctx, exemplars, { count: 10 })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(directions).toHaveLength(3)
    expect(complete.mock.calls[0][2]).toEqual({ maxOutputTokens: 999 })
  })
})
