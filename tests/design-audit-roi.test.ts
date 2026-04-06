import { describe, it, expect } from 'vitest'
import {
  computeRoi,
  annotateRoi,
  detectSystemicFindings,
  topByRoi,
} from '../src/design/audit/roi.js'
import type { DesignFinding } from '../src/types.js'

function f(overrides: Partial<DesignFinding> = {}): DesignFinding {
  return {
    category: 'spacing',
    severity: 'major',
    description: 'test finding',
    location: 'somewhere',
    suggestion: 'fix it',
    ...overrides,
  }
}

describe('computeRoi', () => {
  it('returns 1.0 when all fields are missing (defaults: impact=5, effort=5, blast=page)', () => {
    expect(computeRoi(f())).toBe(1.0)
  })

  it('rewards high-blast fixes', () => {
    const page = f({ impact: 5, effort: 5, blast: 'page' })
    const system = f({ impact: 5, effort: 5, blast: 'system' })
    expect(computeRoi(system)).toBeGreaterThan(computeRoi(page))
  })

  it('penalizes high-effort fixes', () => {
    const easy = f({ impact: 8, effort: 1, blast: 'page' })
    const hard = f({ impact: 8, effort: 8, blast: 'page' })
    expect(computeRoi(easy)).toBeGreaterThan(computeRoi(hard))
  })

  it('rewards high-impact fixes', () => {
    const low = f({ impact: 2, effort: 3, blast: 'page' })
    const high = f({ impact: 9, effort: 3, blast: 'page' })
    expect(computeRoi(high)).toBeGreaterThan(computeRoi(low))
  })

  it('handles effort=0 by treating it as 1 (no division by zero)', () => {
    const finding = f({ impact: 8, effort: 0, blast: 'system' })
    expect(Number.isFinite(computeRoi(finding))).toBe(true)
    expect(computeRoi(finding)).toBeGreaterThan(0)
  })

  it('matches the formula (impact * blastWeight) / effort', () => {
    // page weight = 1, so roi = impact/effort
    expect(computeRoi(f({ impact: 6, effort: 2, blast: 'page' }))).toBe(3)
    // system weight = 2.5, so roi = (6 * 2.5) / 2 = 7.5
    expect(computeRoi(f({ impact: 6, effort: 2, blast: 'system' }))).toBe(7.5)
  })
})

describe('annotateRoi', () => {
  it('mutates findings in place with computed roi', () => {
    const findings = [
      f({ impact: 8, effort: 2, blast: 'page' }),
      f({ impact: 5, effort: 1, blast: 'system' }),
    ]
    annotateRoi(findings)
    expect(findings[0].roi).toBe(4) // 8/2
    expect(findings[1].roi).toBe(12.5) // (5 * 2.5) / 1
  })

  it('returns the same array (chainable)', () => {
    const findings: DesignFinding[] = []
    expect(annotateRoi(findings)).toBe(findings)
  })
})

describe('detectSystemicFindings', () => {
  it('returns empty array for empty input', () => {
    expect(detectSystemicFindings([])).toEqual([])
  })

  it('passes through singleton findings unchanged', () => {
    const result = detectSystemicFindings([
      [f({ description: 'unique to page 1' })],
      [f({ description: 'unique to page 2' })],
    ])
    expect(result).toHaveLength(2)
    expect(result.every(r => r.blast !== 'system' || r.pageCount === undefined)).toBe(true)
  })

  it('collapses duplicate findings across pages into one systemic finding', () => {
    const result = detectSystemicFindings([
      [f({ description: 'card padding is inconsistent' })],
      [f({ description: 'card padding is inconsistent' })],
      [f({ description: 'card padding is inconsistent' })],
    ])
    const systemic = result.filter(r => r.blast === 'system')
    expect(systemic).toHaveLength(1)
    expect(systemic[0].pageCount).toBe(3)
    expect(systemic[0].description).toContain('appears on 3 pages')
  })

  it('does not merge findings from different categories', () => {
    const result = detectSystemicFindings([
      [f({ category: 'spacing', description: 'inconsistent gaps' })],
      [f({ category: 'typography', description: 'inconsistent gaps' })],
    ])
    expect(result.filter(r => r.blast === 'system')).toHaveLength(0)
    expect(result).toHaveLength(2)
  })

  it('normalizes case and whitespace when grouping', () => {
    const result = detectSystemicFindings([
      [f({ description: 'Card padding is inconsistent' })],
      [f({ description: 'card padding is INCONSISTENT' })],
      [f({ description: '  card padding is   inconsistent  ' })],
    ])
    const systemic = result.filter(r => r.blast === 'system')
    expect(systemic).toHaveLength(1)
    expect(systemic[0].pageCount).toBe(3)
  })

  it('does not collapse findings within a single page', () => {
    const result = detectSystemicFindings([
      [
        f({ description: 'duplicate finding' }),
        f({ description: 'duplicate finding' }),
      ],
    ])
    // Same page = not systemic. Both findings should be returned.
    const systemic = result.filter(r => r.blast === 'system')
    expect(systemic).toHaveLength(0)
  })

  it('recomputes ROI for promoted systemic findings', () => {
    const result = detectSystemicFindings([
      [f({ description: 'shared issue', impact: 6, effort: 2, blast: 'page' })],
      [f({ description: 'shared issue', impact: 6, effort: 2, blast: 'page' })],
    ])
    const systemic = result.find(r => r.blast === 'system')
    expect(systemic).toBeDefined()
    // ROI should be computed with system blast: (6 * 2.5) / 2 = 7.5
    expect(systemic!.roi).toBe(7.5)
  })

  it('orders systemic findings before singletons in output', () => {
    const result = detectSystemicFindings([
      [
        f({ description: 'shared' }),
        f({ description: 'page1 unique' }),
      ],
      [
        f({ description: 'shared' }),
        f({ description: 'page2 unique' }),
      ],
    ])
    expect(result[0].blast).toBe('system')
    expect(result.slice(1).every(r => r.blast !== 'system')).toBe(true)
  })
})

describe('topByRoi', () => {
  it('returns findings sorted by ROI descending', () => {
    const findings = [
      f({ description: 'low roi', impact: 2, effort: 5, blast: 'page' }),
      f({ description: 'high roi', impact: 9, effort: 1, blast: 'system' }),
      f({ description: 'mid roi', impact: 6, effort: 2, blast: 'component' }),
    ]
    const sorted = topByRoi(findings, 3)
    expect(sorted[0].description).toBe('high roi')
    expect(sorted[1].description).toBe('mid roi')
    expect(sorted[2].description).toBe('low roi')
  })

  it('respects the limit', () => {
    const findings = [
      f({ description: 'a', impact: 9, effort: 1 }),
      f({ description: 'b', impact: 8, effort: 1 }),
      f({ description: 'c', impact: 7, effort: 1 }),
      f({ description: 'd', impact: 6, effort: 1 }),
    ]
    expect(topByRoi(findings, 2)).toHaveLength(2)
  })

  it('breaks ties by severity then description', () => {
    const findings = [
      f({ description: 'z', severity: 'minor', impact: 5, effort: 5 }),
      f({ description: 'a', severity: 'critical', impact: 5, effort: 5 }),
      f({ description: 'm', severity: 'major', impact: 5, effort: 5 }),
    ]
    const sorted = topByRoi(findings, 3)
    expect(sorted[0].severity).toBe('critical')
    expect(sorted[1].severity).toBe('major')
    expect(sorted[2].severity).toBe('minor')
  })

  it('does not mutate the input array', () => {
    const findings = [
      f({ description: 'a', impact: 1, effort: 5 }),
      f({ description: 'b', impact: 9, effort: 1 }),
    ]
    const original = [...findings]
    topByRoi(findings, 2)
    expect(findings).toEqual(original)
  })
})
