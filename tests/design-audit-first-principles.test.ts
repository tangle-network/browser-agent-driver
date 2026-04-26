import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldTriggerFirstPrinciples,
  buildNovelPatternObservation,
  appendNovelPatternObservation,
} from '../src/design/audit/first-principles-mode.js'
import type { EnsembleClassification } from '../src/design/audit/v2/types.js'
import { readFileSync, existsSync } from 'node:fs'

function makeClassification(overrides: Partial<EnsembleClassification> = {}): EnsembleClassification {
  return {
    type: 'saas-app',
    domain: '',
    maturity: 'production',
    designSystem: 'unknown',
    signals: [],
    signalsAgreed: true,
    ensembleConfidence: 0.85,
    firstPrinciplesMode: false,
    ...overrides,
  }
}

describe('shouldTriggerFirstPrinciples', () => {
  it('does not trigger on high-confidence agreed classification', () => {
    expect(shouldTriggerFirstPrinciples(makeClassification())).toBe(false)
  })

  it('triggers when ensembleConfidence < 0.6', () => {
    expect(shouldTriggerFirstPrinciples(makeClassification({ ensembleConfidence: 0.4 }))).toBe(true)
  })

  it('triggers when signals disagree', () => {
    expect(shouldTriggerFirstPrinciples(makeClassification({ signalsAgreed: false }))).toBe(true)
  })

  it('triggers when type is unknown', () => {
    expect(shouldTriggerFirstPrinciples(makeClassification({ type: 'unknown' as never }))).toBe(true)
  })

  it('triggers when firstPrinciplesMode flag is set', () => {
    expect(shouldTriggerFirstPrinciples(makeClassification({ firstPrinciplesMode: true }))).toBe(true)
  })

  it('respects custom threshold', () => {
    const cl = makeClassification({ ensembleConfidence: 0.72 })
    expect(shouldTriggerFirstPrinciples(cl, { confidenceThreshold: 0.8 })).toBe(true)
    expect(shouldTriggerFirstPrinciples(cl, { confidenceThreshold: 0.7 })).toBe(false)
  })
})

describe('buildNovelPatternObservation', () => {
  it('produces a stable observationId for the same pageRef within the same minute', () => {
    const cl = makeClassification({ ensembleConfidence: 0.3, signalsAgreed: false })
    const obs1 = buildNovelPatternObservation({ classification: cl, pageRef: 'https://example.com' })
    const obs2 = buildNovelPatternObservation({ classification: cl, pageRef: 'https://example.com' })
    expect(obs1.observationId).toBe(obs2.observationId)
  })

  it('carries closestType and closestConfidence from the classification', () => {
    const cl = makeClassification({ type: 'marketing', ensembleConfidence: 0.45 })
    const obs = buildNovelPatternObservation({ classification: cl, pageRef: 'https://test.com' })
    expect(obs.closestType).toBe('marketing')
    expect(obs.closestConfidence).toBe(0.45)
  })
})

describe('appendNovelPatternObservation', () => {
  let tmpDir: string
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a valid JSON line and round-trips', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bad-fp-test-'))
    const cl = makeClassification({ ensembleConfidence: 0.2 })
    const obs = buildNovelPatternObservation({ classification: cl, pageRef: 'https://example.com' })
    await appendNovelPatternObservation(obs, tmpDir)

    const date = obs.capturedAt.slice(0, 10)
    const filePath = join(tmpDir, `${date}.jsonl`)
    expect(existsSync(filePath)).toBe(true)

    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.observationId).toBe(obs.observationId)
    expect(parsed.pageRef).toBe('https://example.com')
  })
})
