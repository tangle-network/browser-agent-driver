import { describe, it, expect } from 'vitest'
import {
  matchGoldenFindings,
  weightedRecall,
  precision,
  passOrthogonality,
  stddev,
  mean,
  objectiveVectorFromTrials,
  aggregateObjectiveVectors,
} from '../bench/design/gepa/metrics.js'
import type { FixtureCase, TrialResult } from '../bench/design/gepa/types.js'
import type { DesignFinding } from '../src/design/audit/types.js'

function fixture(overrides: Partial<FixtureCase> = {}): FixtureCase {
  return {
    id: 'no-primary',
    name: 'No primary action',
    source: { type: 'file', target: 'pages/no-primary-action.html' },
    goldenFindings: [
      { id: 'a', category: 'product', severity: 'critical', any: ['primary action', 'no clear primary'], hint: '' },
      { id: 'b', category: 'product', severity: 'major', any: ['equal weight'], hint: '' },
      { id: 'c', category: 'workflow', severity: 'minor', any: ['no next step'], hint: '' },
    ],
    ...overrides,
  }
}

function finding(description: string, location = '', extra: Partial<DesignFinding> = {}): DesignFinding {
  return {
    category: 'ux',
    severity: 'major',
    description,
    location,
    suggestion: '',
    ...extra,
  }
}

function trial(args: Partial<TrialResult> = {}): TrialResult {
  return {
    variantId: 'v1',
    fixtureId: 'no-primary',
    rep: 0,
    ok: true,
    score: 6,
    findings: [],
    goldenMatches: [],
    tokensUsed: 1000,
    durationMs: 4000,
    ...args,
  }
}

describe('matchGoldenFindings', () => {
  it('matches a substring case-insensitively', () => {
    const fix = fixture()
    const findings = [finding('No clear PRIMARY ACTION on the welcome screen')]
    expect(matchGoldenFindings(fix, findings)).toEqual([true, false, false])
  })

  it('matches against location too', () => {
    const fix = fixture()
    const findings = [finding('action buttons compete', 'workspace home → equal weight grid')]
    expect(matchGoldenFindings(fix, findings)).toEqual([false, true, false])
  })

  it('returns all-false when no findings', () => {
    expect(matchGoldenFindings(fixture(), [])).toEqual([false, false, false])
  })

  it('honours anyRegex when provided', () => {
    const fix = fixture({
      goldenFindings: [
        { id: 'a', category: 'product', severity: 'major', any: [], anyRegex: ['no\\s+primary'], hint: '' },
      ],
    })
    expect(matchGoldenFindings(fix, [finding('there is no   primary CTA')])).toEqual([true])
  })
})

describe('weightedRecall', () => {
  it('weights critical 3x, major 2x, minor 1x', () => {
    const fix = fixture()
    // total weight = 3 + 2 + 1 = 6
    expect(weightedRecall(fix, [true, false, false])).toBeCloseTo(3 / 6) // critical hit only
    expect(weightedRecall(fix, [false, true, false])).toBeCloseTo(2 / 6) // major hit only
    expect(weightedRecall(fix, [true, true, true])).toBe(1)
    expect(weightedRecall(fix, [false, false, false])).toBe(0)
  })

  it('returns 1 when there are no goldens (reference fixture)', () => {
    expect(weightedRecall(fixture({ goldenFindings: [] }), [])).toBe(1)
  })
})

describe('precision', () => {
  it('returns 1 when nothing was emitted', () => {
    expect(precision(fixture(), [])).toBe(1)
  })

  it('returns the share of findings that match a golden phrase', () => {
    const fix = fixture()
    const findings = [
      finding('Primary action is unclear'),
      finding('Some unrelated polish nit'),
      finding('No clear primary visible'),
    ]
    expect(precision(fix, findings)).toBeCloseTo(2 / 3)
  })
})

describe('passOrthogonality', () => {
  it('returns 1 when fewer than 2 passes', () => {
    expect(passOrthogonality([])).toBe(1)
    expect(passOrthogonality([{ findings: [finding('a thing')] }])).toBe(1)
  })

  it('drops toward 0 when passes share heavy lexical overlap', () => {
    const findings = [finding('typography spacing rhythm hierarchy hierarchy')]
    const orth = passOrthogonality([{ findings }, { findings }])
    expect(orth).toBeLessThan(0.05)
  })

  it('approaches 1 when passes share little vocabulary', () => {
    const passA = [finding('typography rhythm spacing hierarchy')]
    const passB = [finding('compliance disclosure consent provenance verification')]
    const orth = passOrthogonality([{ findings: passA }, { findings: passB }])
    expect(orth).toBeGreaterThan(0.9)
  })
})

describe('stddev/mean', () => {
  it('mean handles empty', () => {
    expect(mean([])).toBe(0)
  })

  it('stddev returns 0 for n<2', () => {
    expect(stddev([])).toBe(0)
    expect(stddev([5])).toBe(0)
  })

  it('stddev of [5,7,9]', () => {
    expect(stddev([5, 7, 9])).toBeCloseTo(2)
  })
})

describe('objectiveVectorFromTrials', () => {
  it('aggregates recall, precision, stability, cost across reps', () => {
    const fix = fixture()
    const trials: TrialResult[] = [
      trial({
        score: 6,
        findings: [finding('No clear primary action'), finding('Cards have equal weight')],
        goldenMatches: [true, true, false],
        tokensUsed: 1000,
      }),
      trial({
        rep: 1,
        score: 7,
        findings: [finding('No clear primary action')],
        goldenMatches: [true, false, false],
        tokensUsed: 1100,
      }),
    ]
    const vec = objectiveVectorFromTrials(fix, trials)
    // recall: rep0 = 5/6, rep1 = 3/6 → mean ≈ 0.667
    expect(vec.recall).toBeCloseTo(0.6667, 3)
    // precision: rep0 = 2/2 = 1, rep1 = 1/1 = 1 → mean = 1
    expect(vec.precision).toBe(1)
    // stability: stddev of [6,7] = 0.707, normalised to 1 - 0.707/3 ≈ 0.764
    expect(vec.scoreStability).toBeCloseTo(1 - 0.7071 / 3, 2)
    // cost: mean(1000, 1100) = 1050
    expect(vec.cost).toBe(1050)
  })

  it('drops failed trials from the aggregate', () => {
    const fix = fixture()
    const trials: TrialResult[] = [
      trial({ ok: false, score: 0, findings: [], goldenMatches: [false, false, false], tokensUsed: 0 }),
      trial({ rep: 1, score: 8, findings: [finding('No clear primary action')], goldenMatches: [true, false, false], tokensUsed: 800 }),
    ]
    const vec = objectiveVectorFromTrials(fix, trials)
    expect(vec.cost).toBe(800)
    expect(vec.recall).toBeCloseTo(0.5)
  })
})

describe('aggregateObjectiveVectors', () => {
  it('averages each axis', () => {
    const v = aggregateObjectiveVectors([
      { recall: 0.5, precision: 0.6, passOrthogonality: 0.7, scoreStability: 0.8, cost: 1000 },
      { recall: 0.7, precision: 0.4, passOrthogonality: 0.3, scoreStability: 0.6, cost: 2000 },
    ])
    expect(v.recall).toBeCloseTo(0.6)
    expect(v.precision).toBeCloseTo(0.5)
    expect(v.cost).toBe(1500)
  })

  it('returns zeros for empty input', () => {
    expect(aggregateObjectiveVectors([])).toEqual({
      recall: 0,
      precision: 0,
      passOrthogonality: 0,
      scoreStability: 0,
      cost: 0,
    })
  })
})
