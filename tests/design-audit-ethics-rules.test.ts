/**
 * Layer 7 — ethics rule loader tests.
 *
 * Asserts the four canonical YAML rule files (medical, kids, finance, legal)
 * load without error, every rule's `appliesWhen` predicate is well-formed and
 * matches the expected classification surface, and every rule has a passing +
 * failing fixture pair under bench/design/ethics-fixtures/.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadEthicsRules,
  clearEthicsRuleCache,
  rollupCapFor,
} from '../src/design/audit/ethics/loader.js'
import { appliesWhenMatches, pageTextBlob } from '../src/design/audit/ethics/check.js'
import type { EthicsRule, PageClassification } from '../src/design/audit/v2/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RULES_DIR = path.resolve(__dirname, '../src/design/audit/ethics/rules')
const FIXTURES_DIR = path.resolve(__dirname, '../bench/design/ethics-fixtures')

function makeClassification(over: Partial<PageClassification> = {}): PageClassification {
  return {
    type: 'saas-app',
    domain: 'general',
    framework: null,
    designSystem: 'unknown',
    maturity: 'shipped',
    intent: 'unspecified',
    confidence: 0.9,
    ...over,
  }
}

beforeEach(() => clearEthicsRuleCache())

describe('ethics rule loader', () => {
  it('loads all four rule files without error', () => {
    const rules = loadEthicsRules(RULES_DIR)
    expect(rules.length).toBeGreaterThanOrEqual(8)
    const cats = new Set(rules.map(r => r.category))
    expect(cats).toEqual(new Set(['medical', 'kids', 'finance', 'legal']))
  })

  it('every rule has the required structural fields', () => {
    const rules = loadEthicsRules(RULES_DIR)
    for (const r of rules) {
      expect(r.ruleId).toMatch(/^[a-z]+:[a-z0-9-]+$/)
      expect(['critical-floor', 'major-floor']).toContain(r.severity)
      expect(['medical', 'kids', 'finance', 'legal']).toContain(r.category)
      expect(r.remediation.length).toBeGreaterThan(10)
      expect(r.detector).toBeDefined()
      // Citation is optional but every shipped rule should carry one — ethics
      // without a regulation reference is opinion, not policy.
      expect(r.citation).toBeDefined()
    }
  })

  it('rollupCapFor returns 4 for critical-floor and 6 for major-floor', () => {
    expect(rollupCapFor('critical-floor')).toBe(4)
    expect(rollupCapFor('major-floor')).toBe(6)
  })

  it('caches by directory — second call returns the same array', () => {
    const a = loadEthicsRules(RULES_DIR)
    const b = loadEthicsRules(RULES_DIR)
    expect(a).toBe(b)
  })

  it('returns [] for a missing directory without throwing', () => {
    const missing = path.join(__dirname, '__nonexistent_ethics_dir__')
    expect(loadEthicsRules(missing)).toEqual([])
  })
})

describe('appliesWhen predicates', () => {
  const rules = loadEthicsRules(RULES_DIR)
  const byId = new Map(rules.map(r => [r.ruleId, r]))

  it('medical:dosage-warning-required matches a pharmacy classification', () => {
    const rule = byId.get('medical:dosage-warning-required')!
    const ok = appliesWhenMatches(rule.appliesWhen, {
      pageText: '',
      snapshot: '',
      classification: makeClassification({ domain: 'pharmacy' }),
    })
    expect(ok).toBe(true)
  })

  it('medical:dosage-warning-required does NOT match a general saas page', () => {
    const rule = byId.get('medical:dosage-warning-required')!
    const ok = appliesWhenMatches(rule.appliesWhen, {
      pageText: '',
      snapshot: '',
      classification: makeClassification({ domain: 'devtools' }),
    })
    expect(ok).toBe(false)
  })

  it('kids:dark-patterns-prohibited matches when audience=[kids]', () => {
    const rule = byId.get('kids:dark-patterns-prohibited')!
    const ctx = {
      pageText: '',
      snapshot: '',
      classification: makeClassification(),
      audience: ['kids'] as const,
    }
    expect(appliesWhenMatches(rule.appliesWhen, ctx as never)).toBe(true)
  })

  it('kids:age-gate-required requires both audience=kids AND minor-facing vulnerability', () => {
    const rule = byId.get('kids:age-gate-required')!
    expect(
      appliesWhenMatches(rule.appliesWhen, {
        pageText: '',
        snapshot: '',
        classification: makeClassification(),
        audience: ['kids'],
      } as never),
    ).toBe(false)
    expect(
      appliesWhenMatches(rule.appliesWhen, {
        pageText: '',
        snapshot: '',
        classification: makeClassification(),
        audience: ['kids'],
        audienceVulnerability: ['minor-facing'],
      } as never),
    ).toBe(true)
  })

  it('finance:fees-disclosed-pre-commitment matches ecommerce + fintech domain', () => {
    const rule = byId.get('finance:fees-disclosed-pre-commitment')!
    const ok = appliesWhenMatches(rule.appliesWhen, {
      pageText: '',
      snapshot: '',
      classification: makeClassification({ type: 'ecommerce', domain: 'payments' }),
    })
    expect(ok).toBe(true)
  })

  it('legal:gdpr-cookie-consent matches when regulatoryContext includes gdpr', () => {
    const rule = byId.get('legal:gdpr-cookie-consent')!
    expect(
      appliesWhenMatches(rule.appliesWhen, {
        pageText: '',
        snapshot: '',
        classification: makeClassification(),
        regulatoryContext: ['gdpr'],
      } as never),
    ).toBe(true)
    expect(
      appliesWhenMatches(rule.appliesWhen, {
        pageText: '',
        snapshot: '',
        classification: makeClassification(),
      }),
    ).toBe(false)
  })
})

describe('fixture pairs', () => {
  // Map each rule (or rule cluster) to a passing + failing fixture. Every
  // shipped rule MUST have ≥1 of each per the RFC success metrics.
  const pairs: Array<{ ruleId: string; passing: string; failing: string }> = [
    {
      ruleId: 'medical:dosage-warning-required',
      passing: 'medical-with-dosage.html',
      failing: 'medical-no-dosage.html',
    },
    {
      ruleId: 'kids:age-gate-required',
      passing: 'kids-age-gated.html',
      failing: 'kids-dark-pattern.html',
    },
    {
      ruleId: 'finance:fees-disclosed-pre-commitment',
      passing: 'finance-disclosed-fees.html',
      failing: 'finance-hidden-fees.html',
    },
    {
      ruleId: 'legal:gdpr-cookie-consent',
      passing: 'gdpr-with-consent.html',
      failing: 'gdpr-no-consent.html',
    },
  ]

  it.each(pairs)('rule $ruleId has fixture pair on disk', ({ passing, failing }) => {
    expect(fs.existsSync(path.join(FIXTURES_DIR, passing))).toBe(true)
    expect(fs.existsSync(path.join(FIXTURES_DIR, failing))).toBe(true)
  })

  it('pattern-absent rules detect their pattern in the passing fixture', () => {
    const rules = loadEthicsRules(RULES_DIR)
    const byId = new Map(rules.map(r => [r.ruleId, r]))
    for (const { ruleId, passing } of pairs) {
      const rule = byId.get(ruleId) as EthicsRule | undefined
      if (!rule) throw new Error(`rule ${ruleId} not loaded`)
      if (rule.detector.kind !== 'pattern-absent') continue
      const html = fs.readFileSync(path.join(FIXTURES_DIR, passing), 'utf-8')
      const re = new RegExp(rule.detector.pattern, 'i')
      expect(re.test(html.toLowerCase())).toBe(true)
    }
  })

  it('pattern-absent rules miss the pattern in the failing fixture', () => {
    const rules = loadEthicsRules(RULES_DIR)
    const byId = new Map(rules.map(r => [r.ruleId, r]))
    for (const { ruleId, failing } of pairs) {
      const rule = byId.get(ruleId) as EthicsRule | undefined
      if (!rule) throw new Error(`rule ${ruleId} not loaded`)
      if (rule.detector.kind !== 'pattern-absent') continue
      const html = fs.readFileSync(path.join(FIXTURES_DIR, failing), 'utf-8')
      const blob = pageTextBlob(html)
      const re = new RegExp(rule.detector.pattern, 'i')
      expect(re.test(blob)).toBe(false)
    }
  })
})
