import { describe, it, expect } from 'vitest'
import {
  parseFragment,
  fragmentApplies,
  composeRubric,
  composeRubricFromProfile,
  loadFragments,
} from '../src/design/audit/rubric/loader.js'
import type { PageClassification, RubricFragment } from '../src/design/audit/types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

function makeClassification(overrides: Partial<PageClassification> = {}): PageClassification {
  return {
    type: 'marketing',
    domain: 'fintech',
    framework: 'next',
    designSystem: 'fully-custom',
    maturity: 'polished',
    intent: 'sell payment processing',
    confidence: 0.9,
    ...overrides,
  }
}

describe('rubric loader', () => {
  describe('parseFragment', () => {
    it('parses YAML frontmatter and body from a temp file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-'))
      const file = path.join(dir, 'test-fragment.md')
      fs.writeFileSync(
        file,
        `---
id: test-fragment
title: Test Fragment
weight: high
applies-when:
  type: [marketing, saas-app]
  domain: [fintech]
---
This is the body.

More body.`,
      )

      const fragment = parseFragment(file)
      expect(fragment.id).toBe('test-fragment')
      expect(fragment.title).toBe('Test Fragment')
      expect(fragment.weight).toBe('high')
      expect(fragment.appliesWhen.type).toEqual(['marketing', 'saas-app'])
      expect(fragment.appliesWhen.domain).toEqual(['fintech'])
      expect(fragment.body).toContain('This is the body.')

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('parses universal fragments', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-'))
      const file = path.join(dir, 'universal.md')
      fs.writeFileSync(
        file,
        `---
id: universal
title: Universal
weight: critical
applies-when:
  universal: true
---
Universal body`,
      )

      const fragment = parseFragment(file)
      expect(fragment.appliesWhen.universal).toBe(true)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('throws on missing frontmatter', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-'))
      const file = path.join(dir, 'bad.md')
      fs.writeFileSync(file, 'no frontmatter here')
      expect(() => parseFragment(file)).toThrow(/frontmatter/)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('fragmentApplies', () => {
    const universal: RubricFragment = {
      id: 'u',
      title: 'U',
      weight: 'critical',
      body: '',
      appliesWhen: { universal: true },
    }
    const marketing: RubricFragment = {
      id: 'm',
      title: 'M',
      weight: 'high',
      body: '',
      appliesWhen: { type: ['marketing'] },
    }
    const fintechCrypto: RubricFragment = {
      id: 'fc',
      title: 'FC',
      weight: 'high',
      body: '',
      appliesWhen: { domain: ['fintech', 'crypto'] },
    }

    it('universal fragments always apply', () => {
      expect(fragmentApplies(universal, makeClassification())).toBe(true)
      expect(fragmentApplies(universal, makeClassification({ type: 'docs' }))).toBe(true)
    })

    it('type predicate matches when classification.type is in the set', () => {
      expect(fragmentApplies(marketing, makeClassification({ type: 'marketing' }))).toBe(true)
      expect(fragmentApplies(marketing, makeClassification({ type: 'saas-app' }))).toBe(false)
    })

    it('domain predicate uses substring match (case-insensitive)', () => {
      expect(fragmentApplies(fintechCrypto, makeClassification({ domain: 'fintech' }))).toBe(true)
      expect(fragmentApplies(fintechCrypto, makeClassification({ domain: 'FINTECH' }))).toBe(true)
      expect(fragmentApplies(fintechCrypto, makeClassification({ domain: 'cryptocurrency' }))).toBe(
        true,
      )
      expect(fragmentApplies(fintechCrypto, makeClassification({ domain: 'devtools' }))).toBe(false)
    })

    it('multi-predicate fragments require all fields to match', () => {
      const both: RubricFragment = {
        id: 'b',
        title: 'B',
        weight: 'high',
        body: '',
        appliesWhen: { type: ['marketing'], domain: ['fintech'] },
      }
      expect(fragmentApplies(both, makeClassification({ type: 'marketing', domain: 'fintech' }))).toBe(true)
      expect(fragmentApplies(both, makeClassification({ type: 'marketing', domain: 'devtools' }))).toBe(false)
      expect(fragmentApplies(both, makeClassification({ type: 'docs', domain: 'fintech' }))).toBe(false)
    })

    it('returns false for fragments with no predicates and not universal', () => {
      const empty: RubricFragment = {
        id: 'e',
        title: 'E',
        weight: 'low',
        body: '',
        appliesWhen: {},
      }
      expect(fragmentApplies(empty, makeClassification())).toBe(false)
    })
  })

  describe('composeRubric (with builtin fragments)', () => {
    it('produces a non-empty rubric for a marketing/fintech page', () => {
      const rubric = composeRubric(makeClassification({ type: 'marketing', domain: 'fintech' }))
      expect(rubric.fragments.length).toBeGreaterThan(0)
      expect(rubric.body.length).toBeGreaterThan(100)
      expect(rubric.calibration).toBeTruthy()
      // Universal foundation should always be present
      expect(rubric.fragments.some(f => f.id === 'universal-foundation')).toBe(true)
      // Marketing fragment should be selected
      expect(rubric.fragments.some(f => f.id === 'type-marketing')).toBe(true)
      // Fintech fragment should be selected
      expect(rubric.fragments.some(f => f.id === 'domain-fintech')).toBe(true)
    })

    it('does not include marketing fragment for a docs page', () => {
      const rubric = composeRubric(makeClassification({ type: 'docs', domain: 'devtools' }))
      expect(rubric.fragments.some(f => f.id === 'type-marketing')).toBe(false)
      expect(rubric.fragments.some(f => f.id === 'type-docs')).toBe(true)
    })

    it('selects template-detection fragment for prototype shadcn apps', () => {
      const rubric = composeRubric(
        makeClassification({ maturity: 'prototype', designSystem: 'shadcn' }),
      )
      expect(rubric.fragments.some(f => f.id === 'maturity-prototype')).toBe(true)
    })

    it('omits template-detection for polished custom apps', () => {
      const rubric = composeRubric(
        makeClassification({ maturity: 'polished', designSystem: 'fully-custom' }),
      )
      expect(rubric.fragments.some(f => f.id === 'maturity-prototype')).toBe(false)
    })

    it('orders fragments by weight (critical first)', () => {
      const rubric = composeRubric(makeClassification())
      const weights = rubric.fragments.map(f => f.weight)
      const order = ['critical', 'high', 'medium', 'low']
      const indices = weights.map(w => order.indexOf(w))
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1])
      }
    })
  })

  describe('composeRubricFromProfile (legacy --profile override)', () => {
    it('selects only the matching type fragment plus universals', () => {
      const rubric = composeRubricFromProfile('marketing')
      expect(rubric.fragments.some(f => f.id === 'type-marketing')).toBe(true)
      expect(rubric.fragments.some(f => f.id === 'universal-foundation')).toBe(true)
      // Should NOT include domain-specific fragments since we're overriding by profile
      expect(rubric.fragments.some(f => f.id === 'domain-fintech')).toBe(false)
    })

    it('handles unknown profiles gracefully (just universals)', () => {
      const rubric = composeRubricFromProfile('totally-not-a-profile')
      expect(rubric.fragments.some(f => f.id === 'universal-foundation')).toBe(true)
      expect(rubric.fragments.some(f => f.id === 'universal-calibration')).toBe(true)
    })
  })

  describe('loadFragments', () => {
    it('loads all builtin fragments without throwing', () => {
      const fragments = loadFragments()
      expect(fragments.length).toBeGreaterThanOrEqual(10)
      // Each fragment must have required fields
      for (const f of fragments) {
        expect(f.id).toBeTruthy()
        expect(f.title).toBeTruthy()
        expect(f.body).toBeTruthy()
      }
    })

    it('returns empty array for nonexistent directory', () => {
      const fragments = loadFragments('/nonexistent/path/to/fragments')
      expect(fragments).toEqual([])
    })
  })
})
