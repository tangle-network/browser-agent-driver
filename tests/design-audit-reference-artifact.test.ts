import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildRedesignArtifact,
  type BuildRedesignArtifactInput,
} from '../src/design/audit/reference/artifact/build.js'
import {
  directionToFindings,
  toReferencePageAuditResult,
} from '../src/design/audit/reference/artifact/to-findings.js'
import {
  renderArtifactMarkdown,
  renderArtifactJson,
  renderRedesignDirectionsSummary,
  renderRedesignTarget,
  writeArtifact,
} from '../src/design/audit/reference/artifact/render.js'
import { measurementsToFindings } from '../src/design/audit/evaluate.js'
import type {
  DesignDNA,
  Exemplar,
  RetrievalResult,
  RankResult,
  TasteVerdict,
  RedesignDirection,
  RedesignArtifact,
  DnaDelta,
  RedesignRunResult,
  QualityAssessment,
  PageClassification,
  DesignSystemScore,
  Dimension,
  DimensionScore,
  DesignFinding,
} from '../src/design/audit/reference/contracts.js'
import type { MeasurementBundle, ContrastFailure, A11yViolation } from '../src/design/audit/types.js'
import type { ConfidenceLevel } from '../src/design/audit/score-types.js'

// ── fixture builders (no network, no browser, no LLM) ────────────────────────

const dna = (url: string): DesignDNA => ({
  url,
  capturedAt: '2026-01-01T00:00:00.000Z',
  type: { steps: [], families: [] },
  color: { roles: { primary: [], secondary: [], accent: [], neutral: [], background: [], border: [] } },
  spacing: { steps: [], density: 'balanced' },
  radii: { steps: [] },
  motion: { durationsMs: [], easings: [], libraries: [] },
  layout: { density: 'balanced', archetype: 'content-flow' },
  components: { buttons: 0, inputs: 0, cards: 0, nav: 0 },
})

const exemplar = (id: string, over: Partial<Exemplar> = {}): Exemplar => ({
  id,
  source: 'rip',
  url: `https://${id}.example`,
  pageType: 'marketing',
  jobToBeDone: 'convert a visitor to signup',
  dna: dna(`https://${id}.example`),
  screenshotPath: `${id}.png`,
  aestheticVector: [0.1, 0.2, 0.3],
  eloRating: 1500,
  ...over,
})

const hit = (id: string, score = 0.9, reasons: string[] = ['nearest aesthetic neighbour']): RetrievalResult => ({
  exemplar: exemplar(id),
  score,
  reasons,
})

const direction = (id: string, groundedIds: string[], over: Partial<RedesignDirection> = {}): RedesignDirection => ({
  id,
  name: `Direction ${id}`,
  rationale: `Why ${id} fits the job`,
  asciiLayout: '+------+\n| hero |\n+------+',
  typeSystem: { families: ['Inter', 'Lora'], scalePx: [16, 20, 25, 31], ratio: 1.25, rationale: 'modular scale' },
  colorSystem: {
    primary: '#2563eb',
    accent: '#f59e0b',
    neutrals: ['#111827', '#6b7280'],
    background: '#ffffff',
    rationale: 'calm editorial palette',
  },
  motionSpec: { durationsMs: [200, 300], easings: ['ease-out'], cues: ['stagger hero cards on enter'] },
  hierarchy: ['Hero headline', 'Feature grid', 'Primary CTA'],
  copy: [{ location: 'h1', before: 'Welcome', after: 'Ship faster' }],
  groundedInExemplarIds: groundedIds,
  ...over,
})

const ranking = (order: string[]): RankResult => ({
  order,
  winnerId: order[0] ?? '',
  bradleyTerry: Object.fromEntries(order.map((id, i) => [id, (order.length - i) / Math.max(1, order.length)])),
  elo: Object.fromEntries(order.map((id, i) => [id, 1500 + (order.length - i) * 12])),
})

const verdict = (aId: string, bId: string, winner: string | 'tie'): TasteVerdict => ({
  aId,
  bId,
  winner,
  margin: 0.4,
  reasons: ['stronger hierarchy'],
})

const delta = (over: Partial<DnaDelta> = {}): DnaDelta => ({
  color: { added: ['primary'], removed: [], changed: [] },
  type: { stepsAdded: 1, stepsRemoved: 0, ratioDelta: 0.05 },
  spacing: { baseUnitFrom: undefined, baseUnitTo: 8, densityChanged: true },
  components: { buttons: 0, inputs: 0, cards: 0, nav: 0 },
  summary: 'Tighter type scale, snap to an 8px grid',
  ...over,
})

const failingContrast = (ratio: number): ContrastFailure => ({
  selector: 'p.muted',
  text: 'subtle text',
  color: '#9aa0a6',
  background: '#ffffff',
  ratio,
  required: 4.5,
  fontSize: 14,
  isLargeText: false,
})

const a11yViolation = (impact: A11yViolation['impact']): A11yViolation => ({
  id: 'color-contrast',
  impact,
  description: 'Elements must have sufficient color contrast',
  tags: ['wcag2aa'],
  nodes: [{ selector: 'button', html: '<button>', failureSummary: 'fix contrast' }],
  helpUrl: 'https://example.com/help',
})

const measurements: MeasurementBundle = {
  contrast: {
    totalChecked: 100,
    aaFailures: [failingContrast(3.2)],
    aaaFailures: [],
    summary: { aaPassRate: 0.9, aaaPassRate: 0.5 },
  },
  a11y: { ran: true, violations: [a11yViolation('serious')], passes: 40 },
  hasBlockingIssues: false,
}

const dimScore = (score: number, confidence: ConfidenceLevel = 'medium'): DimensionScore => ({
  score,
  range: [Math.max(1, score - 1), Math.min(10, score + 1)],
  confidence,
  summary: `dimension resolved at ${score}`,
  primaryFindings: [],
})

const dimensionScores = (over: Partial<Record<Dimension, DimensionScore>> = {}): Record<Dimension, DimensionScore> => ({
  product_intent: dimScore(7),
  visual_craft: dimScore(8),
  trust_clarity: dimScore(7),
  workflow: dimScore(6),
  content_ia: dimScore(7),
  ...over,
})

const designSystemScore: DesignSystemScore = {
  layout: 7,
  typography: 7,
  color: 7,
  spacing: 7,
  components: 7,
  interactions: 7,
  accessibility: 6,
  polish: 7,
}

const quality: QualityAssessment = {
  overallWinRate: 0.45,
  dimensionWinRates: { product_intent: 0.5, visual_craft: 0.6 },
  comparisons: 8,
}

const classification: PageClassification = {
  type: 'marketing',
  domain: 'saas',
  framework: null,
  designSystem: 'tailwind-custom',
  maturity: 'shipped',
  intent: 'convert',
  confidence: 0.8,
}

function baseBuildInput(over: Partial<BuildRedesignArtifactInput> = {}): BuildRedesignArtifactInput {
  return {
    url: 'https://under-audit.example/pricing',
    directions: [direction('d-a', ['ex1']), direction('d-b', ['ex2']), direction('d-c', [])],
    ranking: ranking(['d-b', 'd-a', 'd-c']),
    retrieval: [hit('ex1'), hit('ex2')],
    verdicts: [verdict('d-b', 'd-a', 'd-b')],
    tokensUsed: 1234,
    ...over,
  }
}

function runResult(over: Partial<RedesignRunResult> = {}): RedesignRunResult {
  const artifact = buildRedesignArtifact(baseBuildInput())
  const winner = artifact.directions[0]
  return {
    artifact,
    quality,
    headlineScore: 6.2,
    dimensionScores: dimensionScores(),
    designSystemScore,
    findings: directionToFindings(winner, delta(), measurements),
    classification,
    measurements,
    tokensUsed: 1234,
    ...over,
  }
}

// ── build.ts ─────────────────────────────────────────────────────────────────

describe('buildRedesignArtifact', () => {
  it('orders directions by ranking, winner first, and carries provenance through', () => {
    const a = buildRedesignArtifact(baseBuildInput())
    expect(a.directions.map((d) => d.id)).toEqual(['d-b', 'd-a', 'd-c'])
    expect(a.directions[0].id).toBe(a.ranking.winnerId)
    expect(a.url).toBe('https://under-audit.example/pricing')
    expect(a.retrieval.map((r) => r.exemplar.id)).toEqual(['ex1', 'ex2'])
    expect(a.verdicts).toHaveLength(1)
    expect(a.tokensUsed).toBe(1234)
  })

  it('appends directions the ranker did not place, in original order', () => {
    const a = buildRedesignArtifact(baseBuildInput({ ranking: ranking(['d-c']) }))
    expect(a.directions.map((d) => d.id)).toEqual(['d-c', 'd-a', 'd-b'])
  })

  it('attaches referenceId only when supplied', () => {
    expect(buildRedesignArtifact(baseBuildInput()).referenceId).toBeUndefined()
    expect(buildRedesignArtifact(baseBuildInput({ referenceId: 'ref-1' })).referenceId).toBe('ref-1')
  })

  it('throws fail-closed when a direction is grounded in an unretrieved exemplar', () => {
    const input = baseBuildInput({
      directions: [direction('d-a', ['ex-missing'])],
      ranking: ranking(['d-a']),
    })
    expect(() => buildRedesignArtifact(input)).toThrow(/fabricated provenance/)
  })

  it('is deterministic', () => {
    expect(buildRedesignArtifact(baseBuildInput())).toEqual(buildRedesignArtifact(baseBuildInput()))
  })
})

// ── to-findings.ts (compatibility layer) ──────────────────────────────────────

describe('directionToFindings', () => {
  const winner = direction('d-a', ['ex1'])
  const findings = directionToFindings(winner, delta(), measurements)
  const CLOSED_ENUM: ReadonlySet<DesignFinding['category']> = new Set([
    'visual-bug',
    'layout',
    'contrast',
    'alignment',
    'spacing',
    'typography',
    'accessibility',
    'ux',
  ])

  it('emits only categories inside the closed DesignFinding enum', () => {
    for (const f of findings) expect(CLOSED_ENUM.has(f.category)).toBe(true)
  })

  it('emits all directional findings as minor (never major/critical)', () => {
    const directional = findings.filter((f) => f.category !== 'contrast' && f.category !== 'accessibility')
    expect(directional.length).toBeGreaterThan(0)
    for (const f of directional) expect(f.severity).toBe('minor')
  })

  it('sources contrast/accessibility findings ONLY from measurementsToFindings', () => {
    const measured = measurementsToFindings(measurements)
    const measuredCats = findings.filter((f) => f.category === 'contrast' || f.category === 'accessibility')
    // Same count and same descriptions — the generator never invents measured facts.
    expect(measuredCats).toHaveLength(measured.length)
    expect(new Set(measuredCats.map((f) => f.description))).toEqual(new Set(measured.map((f) => f.description)))
    expect(measuredCats.length).toBeGreaterThan(0)
  })

  it('annotates and ROI-sorts the union descending', () => {
    for (const f of findings) expect(typeof f.roi).toBe('number')
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1].roi ?? 0).toBeGreaterThanOrEqual(findings[i].roi ?? 0)
    }
  })

  it('omits the spacing finding when the gap shows no rhythm change', () => {
    const noChange = directionToFindings(
      winner,
      delta({ spacing: { baseUnitFrom: 8, baseUnitTo: 8, densityChanged: false } }),
      measurements,
    )
    expect(noChange.some((f) => f.category === 'spacing')).toBe(false)
  })

  it('does not phrase a "from Xpx to Xpx" re-base when the base unit is unchanged (density-only gap)', () => {
    const out = directionToFindings(
      winner,
      delta({
        spacing: { baseUnitFrom: 4, baseUnitTo: 4, densityChanged: true },
        summary: 'spacing density shift; components buttons +8',
      }),
      measurements,
    )
    const spacing = out.find((f) => f.category === 'spacing')
    expect(spacing).toBeDefined()
    // The bug: "Re-base the spacing rhythm from 4px to 4px". Must never appear.
    expect(spacing!.description).not.toContain('4px to 4px')
    expect(spacing!.description).not.toMatch(/from\s+\dpx\s+to\s+\dpx/)
    // ...and it still describes the real (density) delta instead of dropping silent.
    expect(spacing!.description.toLowerCase()).toContain('density')
  })

  it('suppresses no-op copy revisions (before === after after trim) and keeps real ones', () => {
    const w = direction('d-a', ['ex1'], {
      copy: [
        { location: 'btn1', before: 'Create project', after: 'Create project' }, // no-op
        { location: 'btn2', before: '  Save  ', after: 'Save' }, // no-op after trim
        { location: 'btn3', before: 'Welcome', after: 'Get started' }, // real revision
        { location: 'hint', after: 'Brand new line' }, // genuine add (before undefined)
      ],
    })
    const descs = directionToFindings(w, delta(), measurements).map((f) => f.description)
    expect(descs.some((d) => d.includes('"Create project" → "Create project"'))).toBe(false)
    expect(descs.some((d) => d.includes('Save'))).toBe(false)
    expect(descs.some((d) => d.includes('"Welcome" → "Get started"'))).toBe(true)
    expect(descs.some((d) => d.includes('Add copy at hint'))).toBe(true)
  })

  it('applies the copy-finding budget AFTER filtering no-ops (no-ops never consume the cap)', () => {
    // Six no-ops would exhaust MAX_COPY_FINDINGS (6) if counted before filtering,
    // starving the one genuine revision. After filtering they cost nothing.
    const noops = Array.from({ length: 6 }, (_, i) => ({ location: `n${i}`, before: `x${i}`, after: `x${i}` }))
    const w = direction('d-a', ['ex1'], { copy: [...noops, { location: 'real', before: 'Old', after: 'New' }] })
    const descs = directionToFindings(w, delta(), measurements).map((f) => f.description)
    expect(descs.some((d) => d.includes('"Old" → "New"'))).toBe(true)
  })
})

// ── scroll-motion advisory (honest-signals gate) ──────────────────────────────

describe('directionToFindings — scroll-motion advisory', () => {
  const winner = direction('d-a', ['ex1'])
  const scrollDrivenMotion = {
    pageHeightRatio: 4,
    reveals: { count: 6, kinds: ['fade', 'slide-up'] },
    stickyCount: 2,
    parallax: 0.4,
    scrollDriven: true,
  }
  const staticMotion = {
    pageHeightRatio: 1.3,
    reveals: { count: 0, kinds: [] },
    stickyCount: 0,
    parallax: 0,
    scrollDriven: false,
  }
  const withScroll = (base: DesignDNA, scroll: typeof scrollDrivenMotion): DesignDNA => ({
    ...base,
    motion: { ...base.motion, scroll },
  })
  const scrollRichHit = (id: string): RetrievalResult => ({
    exemplar: exemplar(id, { dna: withScroll(dna(`https://${id}.example`), scrollDrivenMotion) }),
    score: 0.9,
    reasons: ['nearest aesthetic neighbour'],
  })
  const hasAdvisory = (findings: DesignFinding[]): boolean =>
    findings.some((f) => f.description.includes('static on scroll'))

  const pageStatic = withScroll(dna('https://under-audit.example'), staticMotion)

  it('emits a minor ux advisory naming peers + interactions when the page is static but peers are scroll-rich', () => {
    const findings = directionToFindings(winner, delta(), measurements, pageStatic, [scrollRichHit('ex1'), hit('ex2')])
    const advisory = findings.find((f) => f.description.includes('static on scroll'))
    expect(advisory).toBeDefined()
    expect(advisory!.severity).toBe('minor')
    expect(advisory!.category).toBe('ux')
    expect(advisory!.description).toContain('ex1')
    expect(advisory!.description).toContain('scroll reveals')
  })

  it('does NOT fire when the page scroll was never captured (absent ≠ static)', () => {
    expect(hasAdvisory(directionToFindings(winner, delta(), measurements, dna('https://x'), [scrollRichHit('ex1')]))).toBe(false)
  })

  it('does NOT fire when the audited page is itself scroll-driven', () => {
    const pageRich = withScroll(dna('https://x'), scrollDrivenMotion)
    expect(hasAdvisory(directionToFindings(winner, delta(), measurements, pageRich, [scrollRichHit('ex1')]))).toBe(false)
  })

  it('does NOT fire when no retrieved peer is scroll-rich', () => {
    expect(hasAdvisory(directionToFindings(winner, delta(), measurements, pageStatic, [hit('ex2')]))).toBe(false)
  })

  it('omitting dna/hits is byte-identical to the prior 3-arg behaviour (no advisory)', () => {
    expect(hasAdvisory(directionToFindings(winner, delta(), measurements))).toBe(false)
  })
})

describe('toReferencePageAuditResult', () => {
  it('returns the PageAuditResult contract shape', () => {
    const r = toReferencePageAuditResult(runResult())
    expect(typeof r.url).toBe('string')
    expect(typeof r.score).toBe('number')
    expect(typeof r.summary).toBe('string')
    expect(Array.isArray(r.strengths)).toBe(true)
    expect(Array.isArray(r.findings)).toBe(true)
    expect(r.classification).toBe(classification)
    expect(r.measurements).toBe(measurements)
    expect(r.designSystemScore).toBe(designSystemScore)
    expect(r.tokensUsed).toBe(1234)
  })

  it('reports the engine headline as the single scoring authority (never re-scores)', () => {
    expect(toReferencePageAuditResult(runResult({ headlineScore: 7.3 })).score).toBe(7.3)
    expect(toReferencePageAuditResult(runResult({ headlineScore: 10 })).score).toBe(10)
  })

  it('reports the headline on the DEFAULT-budget all-placeholder path — never deflated by unassessed dims', () => {
    // Default judge budget never affords the per-dimension quality leg, so
    // `quality.dimensionWinRates` is undefined and every dimension is a score-core
    // placeholder (5 / confidence 'low'). A perfect page (win-rate 1.0 ⇒ headline
    // 10) must report 10, NOT a ~5 average of placeholders.
    const placeholder = (): DimensionScore => ({
      score: 5,
      range: [1, 10],
      confidence: 'low',
      summary: 'not independently judged — placeholder',
      primaryFindings: [],
    })
    const allPlaceholder: Record<Dimension, DimensionScore> = {
      product_intent: placeholder(),
      visual_craft: placeholder(),
      trust_clarity: placeholder(),
      workflow: placeholder(),
      content_ia: placeholder(),
    }
    const perfect = runResult({
      headlineScore: 10,
      dimensionScores: allPlaceholder,
      quality: { overallWinRate: 1, comparisons: 4 },
    })
    const out = toReferencePageAuditResult(perfect)
    expect(out.score).toBe(10)
    // ...and it never promotes an unassessed placeholder as a strength: with no
    // judged dimension it states that honestly instead.
    expect(out.strengths).toEqual([expect.stringMatching(/independently judged/i)])
  })

  it('passes the core ROI-sorted findings through unchanged', () => {
    const result = runResult()
    expect(toReferencePageAuditResult(result).findings).toBe(result.findings)
  })

  it('reports the winner and win-rate in the summary', () => {
    const r = toReferencePageAuditResult(runResult())
    expect(r.summary).toContain('Direction d-b')
    expect(r.summary).toContain('45%')
  })

  it('never labels a 0%-win-rate dimension a strength', () => {
    // product_intent is JUDGED but loses every comparison. Give it an artificially
    // high placeholder score to prove win-rate (not score) gates strength.
    const r = toReferencePageAuditResult(
      runResult({
        quality: { overallWinRate: 0, dimensionWinRates: { product_intent: 0 }, comparisons: 1 },
        dimensionScores: dimensionScores({
          product_intent: {
            score: 9,
            range: [8, 10],
            confidence: 'medium',
            summary: 'product_intent: 0% win-rate vs world-class exemplars across 1 pairwise comparison(s).',
            primaryFindings: [],
          },
        }),
      }),
    )
    expect(r.strengths).toHaveLength(1)
    expect(r.strengths[0]).toMatch(/no dimension stood out/i)
    // It is NOT promoted as a strength, and no doubled label leaks through.
    expect(r.strengths[0]).not.toMatch(/Product intent/)
    expect(r.strengths.join('\n')).not.toContain('product_intent: product_intent')
  })

  it('surfaces a genuine strength with a clean, de-doubled label', () => {
    const r = toReferencePageAuditResult(
      runResult({
        quality: { overallWinRate: 0.7, dimensionWinRates: { visual_craft: 0.8 }, comparisons: 5 },
        dimensionScores: dimensionScores({
          visual_craft: {
            score: 9,
            range: [8, 10],
            confidence: 'high',
            summary: 'visual_craft: 80% win-rate vs world-class exemplars across 5 pairwise comparison(s).',
            primaryFindings: [],
          },
        }),
      }),
    )
    expect(r.strengths).toContain(
      'Visual craft: 80% win-rate vs world-class exemplars across 5 pairwise comparison(s).',
    )
    // The raw dimension key must not double up with the human label.
    expect(r.strengths.join('\n')).not.toContain('visual_craft:')
  })

  it('truncates the summary on a word boundary — never mid-word', () => {
    const VOCAB = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const longRationale = Array.from({ length: 200 }, (_, i) => VOCAB[i % VOCAB.length]).join(' ')
    const art = buildRedesignArtifact(
      baseBuildInput({
        directions: [direction('d-long', ['ex1'], { rationale: longRationale })],
        ranking: ranking(['d-long']),
        retrieval: [hit('ex1')],
        verdicts: [],
      }),
    )
    const r = toReferencePageAuditResult(runResult({ artifact: art }))
    expect(r.summary.length).toBeLessThanOrEqual(400)
    expect(r.summary.endsWith('…')).toBe(true)
    // The bug: a hard char cut ending mid-word ("…pairwise compa…"). The kept tail
    // must be a complete word from the source vocabulary, not a fragment.
    const lastWord = r.summary.slice(0, -1).trim().split(' ').pop()
    expect(VOCAB).toContain(lastWord)
  })
})

// ── render.ts ──────────────────────────────────────────────────────────────────

describe('renderArtifactMarkdown', () => {
  const artifact: RedesignArtifact = buildRedesignArtifact(baseBuildInput({ referenceId: 'ref-stripe' }))
  const md = renderArtifactMarkdown(artifact)

  it('renders the full rich artifact (named directions, ascii, systems, hierarchy, copy, provenance)', () => {
    expect(md).toContain('# Redesign directions — https://under-audit.example/pricing')
    expect(md).toContain('Reference: `ref-stripe`')
    // winner marked with a star, ranking table present
    expect(md).toContain('## ★ Direction d-b')
    expect(md).toContain('| rank | direction | Bradley-Terry | Elo |')
    // ASCII layout fenced
    expect(md).toContain('```\n+------+\n| hero |\n+------+\n```')
    // the three systems + hierarchy + copy
    expect(md).toContain('### Type')
    expect(md).toContain('Families: Inter, Lora')
    expect(md).toContain('### Color')
    expect(md).toContain('Primary: #2563eb')
    expect(md).toContain('### Motion')
    expect(md).toContain('stagger hero cards on enter')
    expect(md).toContain('### Hierarchy')
    expect(md).toContain('1. Hero headline')
    expect(md).toContain('### Copy')
    expect(md).toContain('Ship faster')
    // grounding provenance + retrieval list
    expect(md).toContain('Grounded in: `ex2`')
    expect(md).toContain('`ex1` (rip, marketing)')
    // pairwise verdicts
    expect(md).toContain('## Pairwise verdicts')
  })

  it('is deterministic and ends with a single trailing newline', () => {
    expect(renderArtifactMarkdown(artifact)).toBe(md)
    expect(md.endsWith('\n')).toBe(true)
    expect(md.endsWith('\n\n')).toBe(false)
  })

  it('degrades gracefully with no retrieval or ranking', () => {
    const empty = buildRedesignArtifact(
      baseBuildInput({ directions: [], retrieval: [], ranking: ranking([]), verdicts: [] }),
    )
    const out = renderArtifactMarkdown(empty)
    expect(out).toContain('_No exemplars retrieved._')
    expect(out).toContain('_Unranked._')
  })

  it('drops no-op copy rows from the brief Copy table', () => {
    const noopOnly = buildRedesignArtifact(
      baseBuildInput({
        directions: [direction('d-x', ['ex1'], { copy: [{ location: 'btn', before: 'Same', after: 'Same' }] })],
        ranking: ranking(['d-x']),
        retrieval: [hit('ex1')],
        verdicts: [],
      }),
    )
    // The only revision is a no-op, so the Copy section is suppressed entirely.
    expect(renderArtifactMarkdown(noopOnly)).not.toContain('### Copy')

    const mixed = buildRedesignArtifact(
      baseBuildInput({
        directions: [
          direction('d-y', ['ex1'], {
            copy: [
              { location: 'btn', before: 'Same', after: 'Same' },
              { location: 'h1', before: 'Old', after: 'New' },
            ],
          }),
        ],
        ranking: ranking(['d-y']),
        retrieval: [hit('ex1')],
        verdicts: [],
      }),
    )
    const out = renderArtifactMarkdown(mixed)
    expect(out).toContain('### Copy')
    expect(out).toContain('| h1 | Old | New |')
    expect(out).not.toContain('| btn | Same | Same |')
  })
})

describe('renderRedesignDirectionsSummary', () => {
  const artifact = buildRedesignArtifact(baseBuildInput({ referenceId: 'ref-stripe' }))
  const out = renderRedesignDirectionsSummary(artifact, 'brief.redesign.md')

  it('surfaces the winner in brief plus every ranked alternate by name', () => {
    expect(out).toContain('### https://under-audit.example/pricing')
    expect(out).toContain('Grounded in reference `ref-stripe`.')
    expect(out).toContain('**Winner — Direction d-b**')
    expect(out).toContain('Why d-b fits the job')
    expect(out).toContain('Type: Inter, Lora')
    expect(out).toContain('Colour: #2563eb')
    expect(out).toContain('Hierarchy: Hero headline → Feature grid → Primary CTA')
    expect(out).toContain('**Alternate directions (2):**')
    expect(out).toContain('- **Direction d-a**')
    expect(out).toContain('- **Direction d-c**')
    expect(out).toContain('`brief.redesign.md`')
  })

  it('is deterministic and ends with a single trailing newline', () => {
    expect(renderRedesignDirectionsSummary(artifact, 'brief.redesign.md')).toBe(out)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('omits the brief pointer when no file is given and handles an empty artifact', () => {
    expect(renderRedesignDirectionsSummary(artifact)).not.toContain('Full brief')
    const empty = buildRedesignArtifact(
      baseBuildInput({ directions: [], ranking: ranking([]), retrieval: [], verdicts: [] }),
    )
    expect(renderRedesignDirectionsSummary(empty)).toContain('_No ranked direction was produced._')
  })
})

describe('renderRedesignTarget', () => {
  const artifact: RedesignArtifact = buildRedesignArtifact(baseBuildInput({ referenceId: 'ref-stripe' }))

  it('renders the winning direction as an apply-ready, grounded target', () => {
    const out = renderRedesignTarget(artifact)
    expect(out).toContain('REDESIGN TARGET')
    expect(out).toContain('Direction d-b') // winner (ranking d-b, d-a, d-c)
    expect(out).toContain('| hero |') // the winning direction's ascii layout
    expect(out).toContain('Grounded in real reference designs:')
  })

  it('returns empty string when there is no direction to apply', () => {
    const empty = buildRedesignArtifact(
      baseBuildInput({ directions: [], ranking: ranking([]), retrieval: [], verdicts: [] }),
    )
    expect(renderRedesignTarget(empty)).toBe('')
  })
})

describe('renderArtifactJson / writeArtifact', () => {
  it('renders stable pretty JSON', () => {
    const artifact = buildRedesignArtifact(baseBuildInput())
    const json = renderArtifactJson(artifact)
    expect(JSON.parse(json)).toEqual(artifact)
    expect(json.endsWith('\n')).toBe(true)
  })

  it('lands both the json and markdown files in the target dir', async () => {
    const artifact = buildRedesignArtifact(baseBuildInput())
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'redesign-artifact-'))
    try {
      const { jsonPath, markdownPath } = await writeArtifact(artifact, dir)
      expect(path.dirname(jsonPath)).toBe(dir)
      expect(path.dirname(markdownPath)).toBe(dir)
      expect(await fs.readFile(markdownPath, 'utf8')).toBe(renderArtifactMarkdown(artifact))
      expect(JSON.parse(await fs.readFile(jsonPath, 'utf8'))).toEqual(artifact)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
