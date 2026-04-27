/**
 * Layer 7 — ethics check tests.
 *
 * Each test exercises one detector kind end-to-end against a real fixture:
 *   - pattern-absent (medical, gdpr): regex over snapshot text
 *   - llm-classifier (kids, finance): stubbed Brain response
 *   - skip-ethics: pipeline-level bypass behavior
 *
 * The Brain stub is a minimal object that satisfies the call shape used by
 * `runLlmClassifier`. We do NOT mock the entire Brain — we call the public
 * shape (`brain.complete(system, user)`) and assert the prompt the real
 * implementation would send.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadEthicsRules,
  clearEthicsRuleCache,
} from '../src/design/audit/ethics/loader.js'
import {
  checkEthics,
  pageTextBlob,
  runLlmClassifier,
  type EthicsCheckContext,
} from '../src/design/audit/ethics/check.js'
import type { Brain } from '../src/brain/index.js'
import type { PageClassification } from '../src/design/audit/score-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RULES_DIR = path.resolve(__dirname, '../src/design/audit/ethics/rules')
const FIXTURES_DIR = path.resolve(__dirname, '../bench/design/ethics-fixtures')

beforeEach(() => clearEthicsRuleCache())

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8')
}

function classification(over: Partial<PageClassification> = {}): PageClassification {
  return {
    type: 'saas-app',
    domain: 'general',
    framework: null,
    designSystem: 'unknown',
    maturity: 'shipped',
    intent: '',
    confidence: 0.9,
    ...over,
  }
}

function ctxFor(html: string, over: Partial<EthicsCheckContext> = {}): EthicsCheckContext {
  return {
    pageText: pageTextBlob(html),
    snapshot: html,
    classification: over.classification ?? classification(),
    ...over,
  }
}

/** Minimal Brain stub. Records every prompt; returns a scripted answer. */
function stubBrain(reply: (user: string) => string): Brain {
  const calls: Array<{ system: string; user: string }> = []
  const fake = {
    calls,
    async complete(system: string, user: string) {
      calls.push({ system, user })
      return { text: reply(user) }
    },
  }
  return fake as unknown as Brain
}

describe('checkEthics — no rules fire', () => {
  it('returns [] when classification matches no rule', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const violations = await checkEthics(
      rules,
      ctxFor('<html><body>hello</body></html>', {
        classification: classification({ domain: 'devtools', type: 'docs' }),
      }),
    )
    expect(violations).toEqual([])
  })

  it('passing medical fixture triggers no violations when dosage + warning present', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('medical-with-dosage.html')
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification({ domain: 'pharmacy' }),
        // No audience/regulatoryContext set → kids+gdpr rules skip.
      }),
    )
    const dosage = violations.find(v => v.ruleId === 'medical:dosage-warning-required')
    expect(dosage).toBeUndefined()
    // medical:adverse-event-reporting-path: regex must hit MedWatch text.
    const adverse = violations.find(v => v.ruleId === 'medical:adverse-event-reporting-path')
    expect(adverse).toBeUndefined()
  })

  it('passing gdpr fixture with consent banner clears the cookie + privacy rules', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('gdpr-with-consent.html')
    const violations = await checkEthics(
      rules,
      ctxFor(html, { regulatoryContext: ['gdpr'] }),
    )
    expect(violations.find(v => v.ruleId === 'legal:gdpr-cookie-consent')).toBeUndefined()
    expect(violations.find(v => v.ruleId === 'legal:privacy-policy-link-required')).toBeUndefined()
    expect(violations.find(v => v.ruleId === 'legal:ccpa-do-not-sell-link')).toBeUndefined()
  })
})

describe('checkEthics — pattern-absent detectors fire on missing text', () => {
  it('medical fixture missing dosage warnings → critical-floor violation, rollupCap=4', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('medical-no-dosage.html')
    const violations = await checkEthics(
      rules,
      ctxFor(html, { classification: classification({ domain: 'pharmacy' }) }),
    )
    const v = violations.find(x => x.ruleId === 'medical:dosage-warning-required')
    expect(v).toBeDefined()
    expect(v!.severity).toBe('critical-floor')
    expect(v!.rollupCap).toBe(4)
    expect(v!.citation).toMatch(/FDA/i)
    expect(v!.remediation.toLowerCase()).toContain('dosage')
  })

  it('gdpr fixture without consent banner → major-floor violation, rollupCap=6', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('gdpr-no-consent.html')
    const violations = await checkEthics(
      rules,
      ctxFor(html, { regulatoryContext: ['gdpr'] }),
    )
    const v = violations.find(x => x.ruleId === 'legal:gdpr-cookie-consent')
    expect(v).toBeDefined()
    expect(v!.severity).toBe('major-floor')
    expect(v!.rollupCap).toBe(6)
  })
})

describe('checkEthics — llm-classifier detectors', () => {
  it('kids dark-pattern fixture + brain answers yes → critical-floor violation', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('kids-dark-pattern.html')
    const brain = stubBrain((user) => {
      // Sanity-check the auditor sends both the question and the snapshot.
      expect(user).toContain('dark pattern')
      expect(user).toContain('YES, give me coins')
      return 'yes — fake urgency, confirmshaming, friction-asymmetric flow'
    })
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification(),
        audience: ['kids'],
        audienceVulnerability: ['minor-facing'],
      }),
      { brain },
    )
    const v = violations.find(x => x.ruleId === 'kids:dark-patterns-prohibited')
    expect(v).toBeDefined()
    expect(v!.severity).toBe('critical-floor')
    expect(v!.rollupCap).toBe(4)
  })

  it('llm-classifier rules are skipped (warned) when no brain is supplied', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('kids-dark-pattern.html')
    const warns: string[] = []
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification(),
        audience: ['kids'],
        regulatoryContext: ['coppa'],
      }),
      { warn: (m) => warns.push(m) },
    )
    expect(violations.find(v => v.ruleId === 'kids:dark-patterns-prohibited')).toBeUndefined()
    expect(warns.some(w => w.includes('kids:dark-patterns-prohibited'))).toBe(true)
  })

  it('finance hidden-fees fixture + brain confirms hiding → critical-floor violation fires', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('finance-hidden-fees.html')
    // Rule polarity: yes = "fees ARE hidden" = violation. The fixture buries
    // fees in 6px white-on-white text, so a real auditor would say yes.
    const brain = stubBrain(() => 'yes — fees are buried in microcopy below the pay button')
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification({ type: 'ecommerce', domain: 'payments' }),
      }),
      { brain },
    )
    const v = violations.find(x => x.ruleId === 'finance:fees-disclosed-pre-commitment')
    expect(v).toBeDefined()
    expect(v!.severity).toBe('critical-floor')
    expect(v!.rollupCap).toBe(4)
  })

  it('finance disclosed-fees fixture + brain says fees are visible → no fee-disclosure violation', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('finance-disclosed-fees.html')
    // Rule polarity: no = "fees NOT hidden" = compliant.
    const brain = stubBrain(() => 'no — every fee, FX rate, and total is itemized above the pay button')
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification({ type: 'ecommerce', domain: 'payments' }),
      }),
      { brain },
    )
    expect(violations.find(v => v.ruleId === 'finance:fees-disclosed-pre-commitment')).toBeUndefined()
  })

  it('runLlmClassifier truncates oversized snapshots before sending', async () => {
    const huge = 'X'.repeat(20_000)
    let captured = ''
    const brain = stubBrain((user) => {
      captured = user
      return 'no'
    })
    const out = await runLlmClassifier(brain, 'is this safe?', huge)
    expect(out).toBe(false)
    expect(captured).toContain('[truncated]')
    expect(captured.length).toBeLessThan(huge.length)
  })

  it('runLlmClassifier returns false on empty / non-yes responses', async () => {
    const brain = stubBrain(() => '')
    expect(await runLlmClassifier(brain, 'q?', 'snap')).toBe(false)
    const brain2 = stubBrain(() => 'unsure, maybe')
    expect(await runLlmClassifier(brain2, 'q?', 'snap')).toBe(false)
  })
})

describe('rollup cap selection', () => {
  it('takes the lowest cap when multiple rules fire', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('gdpr-no-consent.html')
    // GDPR fixture has neither consent (major-floor=6) nor a privacy policy
    // link (major-floor=6). Both should fire; the cap is 6.
    const violations = await checkEthics(
      rules,
      ctxFor(html, { regulatoryContext: ['gdpr'] }),
    )
    expect(violations.length).toBeGreaterThanOrEqual(2)
    const minCap = Math.min(...violations.map(v => v.rollupCap))
    expect(minCap).toBe(6)
  })

  it('mixing critical-floor with major-floor lowers the cap to 4', async () => {
    const rules = loadEthicsRules(RULES_DIR)
    const html = readFixture('medical-no-dosage.html')
    const violations = await checkEthics(
      rules,
      ctxFor(html, {
        classification: classification({ domain: 'pharmacy' }),
        audienceVulnerability: ['patient-facing'],
      }),
      { brain: stubBrain(() => 'no') },
    )
    // Expect dosage (critical) + adverse-event (major) + patient-education (major)
    const ruleIds = new Set(violations.map(v => v.ruleId))
    expect(ruleIds.has('medical:dosage-warning-required')).toBe(true)
    const minCap = Math.min(...violations.map(v => v.rollupCap))
    expect(minCap).toBe(4)
  })
})

describe('skip-ethics bypass semantics', () => {
  it('caller can short-circuit by passing zero rules', async () => {
    const html = readFixture('medical-no-dosage.html')
    const violations = await checkEthics(
      [],
      ctxFor(html, { classification: classification({ domain: 'pharmacy' }) }),
    )
    expect(violations).toEqual([])
  })
})
