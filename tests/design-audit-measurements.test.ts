import { describe, it, expect } from 'vitest'
import { measurementsToFindings } from '../src/design/audit/evaluate.js'
import { impactToSeverity } from '../src/design/audit/measure/index.js'
import type { MeasurementBundle } from '../src/design/audit/types.js'

function emptyBundle(): MeasurementBundle {
  return {
    contrast: {
      totalChecked: 0,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 1, aaaPassRate: 1 },
    },
    a11y: {
      ran: true,
      violations: [],
      passes: 0,
    },
    hasBlockingIssues: false,
  }
}

describe('measurementsToFindings', () => {
  it('returns empty array when there are no failures', () => {
    expect(measurementsToFindings(emptyBundle())).toEqual([])
  })

  it('groups contrast failures with the same color pair into one finding', () => {
    const bundle = emptyBundle()
    // 15 elements with the SAME color pair → should collapse to 1 finding
    for (let i = 0; i < 15; i++) {
      bundle.contrast.aaFailures.push({
        selector: `.text-${i}`,
        text: `text ${i}`,
        color: '#999999',
        background: '#ffffff',
        ratio: 2.5,
        required: 4.5,
        fontSize: 14,
        isLargeText: false,
      })
    }
    const findings = measurementsToFindings(bundle)
    const contrastFindings = findings.filter(f => f.category === 'contrast')
    expect(contrastFindings).toHaveLength(1)
    expect(contrastFindings[0].description).toContain('15 elements')
    expect(contrastFindings[0].description).toContain('2.5:1')
    expect(contrastFindings[0].description).toContain('4.5:1')
    // 15 elements → blast=system
    expect(contrastFindings[0].blast).toBe('system')
  })

  it('caps contrast groups to top 10 by element count', () => {
    const bundle = emptyBundle()
    // 12 distinct color pairs → 12 groups, capped to 10
    for (let pair = 0; pair < 12; pair++) {
      bundle.contrast.aaFailures.push({
        selector: `.pair-${pair}`,
        text: `text`,
        color: `#11111${pair.toString(16)}`,
        background: '#ffffff',
        ratio: 2.5,
        required: 4.5,
        fontSize: 14,
        isLargeText: false,
      })
    }
    const findings = measurementsToFindings(bundle)
    expect(findings.filter(f => f.category === 'contrast')).toHaveLength(10)
  })

  it('keeps single-element contrast failures as page-blast findings', () => {
    const bundle = emptyBundle()
    bundle.contrast.aaFailures.push({
      selector: '.lonely',
      text: 'only',
      color: '#777777',
      background: '#ffffff',
      ratio: 3.5,
      required: 4.5,
      fontSize: 14,
      isLargeText: false,
    })
    const findings = measurementsToFindings(bundle)
    expect(findings).toHaveLength(1)
    expect(findings[0].blast).toBe('page')
  })

  it('marks contrast failures as critical when ratio is more than 1.5 below required', () => {
    const bundle = emptyBundle()
    bundle.contrast.aaFailures.push({
      selector: '.bad',
      text: 'unreadable',
      color: '#cccccc',
      background: '#ffffff',
      ratio: 1.5, // far below required 4.5
      required: 4.5,
      fontSize: 14,
      isLargeText: false,
    })
    const findings = measurementsToFindings(bundle)
    expect(findings[0].severity).toBe('critical')
  })

  it('marks contrast failures as major when ratio is close to required', () => {
    const bundle = emptyBundle()
    bundle.contrast.aaFailures.push({
      selector: '.borderline',
      text: 'borderline',
      color: '#777777',
      background: '#ffffff',
      ratio: 3.8, // 0.7 below required 4.5
      required: 4.5,
      fontSize: 14,
      isLargeText: false,
    })
    const findings = measurementsToFindings(bundle)
    expect(findings[0].severity).toBe('major')
  })

  it('produces accessibility findings from axe violations (capped at 15)', () => {
    const bundle = emptyBundle()
    for (let i = 0; i < 20; i++) {
      bundle.a11y.violations.push({
        id: `rule-${i}`,
        impact: i < 5 ? 'critical' : i < 10 ? 'serious' : i < 15 ? 'moderate' : 'minor',
        description: `Violation ${i}`,
        tags: ['wcag2aa'],
        helpUrl: `https://example.com/${i}`,
        nodes: [{ selector: `.node-${i}`, html: `<div>${i}</div>`, failureSummary: 'fix me' }],
      })
    }
    const findings = measurementsToFindings(bundle)
    const a11yFindings = findings.filter(f => f.category === 'accessibility')
    expect(a11yFindings).toHaveLength(15)
    // Critical/serious axe impact maps to critical severity
    expect(a11yFindings[0].severity).toBe('critical')
    expect(a11yFindings[5].severity).toBe('critical') // serious also maps to critical
    // Moderate maps to major
    expect(a11yFindings[10].severity).toBe('major')
    // Includes the axe rule id in the description
    expect(a11yFindings[0].description).toContain('rule-0')
  })

  it('a11y findings reference the first node selector and surface the affected count', () => {
    const bundle = emptyBundle()
    bundle.a11y.violations.push({
      id: 'color-contrast',
      impact: 'serious',
      description: 'Insufficient contrast',
      tags: ['wcag2aa'],
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
      nodes: [
        { selector: 'p.muted', html: '<p>muted</p>', failureSummary: 'increase contrast' },
        { selector: 'p.muted2', html: '<p>m2</p>', failureSummary: 'increase contrast' },
      ],
    })
    const findings = measurementsToFindings(bundle)
    expect(findings[0].cssSelector).toBe('p.muted')
    // 2 nodes → location surfaces the count
    expect(findings[0].location).toContain('2 elements')
    expect(findings[0].location).toContain('p.muted')
    // 2 nodes → blast=component
    expect(findings[0].blast).toBe('component')
  })

  it('merges contrast findings before a11y findings', () => {
    const bundle = emptyBundle()
    bundle.contrast.aaFailures.push({
      selector: '.c',
      text: 't',
      color: '#aaa',
      background: '#fff',
      ratio: 2,
      required: 4.5,
      fontSize: 14,
      isLargeText: false,
    })
    bundle.a11y.violations.push({
      id: 'aria-required',
      impact: 'critical',
      description: 'missing required attribute',
      tags: ['wcag2a'],
      helpUrl: '',
      nodes: [{ selector: 'input', html: '<input>', failureSummary: 'add aria-required' }],
    })
    const findings = measurementsToFindings(bundle)
    expect(findings[0].category).toBe('contrast')
    expect(findings[1].category).toBe('accessibility')
  })
})

describe('impactToSeverity', () => {
  it('maps critical and serious to critical', () => {
    expect(impactToSeverity('critical')).toBe('critical')
    expect(impactToSeverity('serious')).toBe('critical')
  })

  it('maps moderate to major', () => {
    expect(impactToSeverity('moderate')).toBe('major')
  })

  it('maps minor to minor', () => {
    expect(impactToSeverity('minor')).toBe('minor')
  })
})
