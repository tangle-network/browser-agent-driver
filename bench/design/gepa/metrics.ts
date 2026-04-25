/**
 * Eval metrics for design-audit prompt evolution.
 *
 * Pure functions over (fixture, audit output, repeated runs). Each is unit-
 * tested in tests/design-audit-gepa-metrics.test.ts; nothing here calls out
 * to a model or a network. That keeps GEPA cheap to debug — most regressions
 * are in the metric, not the prompt.
 */

import type { DesignFinding } from '../../../src/design/audit/types.js'
import type { FixtureCase, GoldenFinding, ObjectiveVector, TrialResult } from './types.js'

/**
 * Match each golden finding against the auditor's actual findings. Match rule:
 *   - any element of `golden.any` appears (case-insensitive) in the finding's
 *     description OR location, OR
 *   - any pattern in `golden.anyRegex` matches the same.
 * Order of `goldenMatches` matches `fixture.goldenFindings`.
 */
export function matchGoldenFindings(
  fixture: FixtureCase,
  findings: DesignFinding[],
): boolean[] {
  return fixture.goldenFindings.map((golden) => goldenMatched(golden, findings))
}

function goldenMatched(golden: GoldenFinding, findings: DesignFinding[]): boolean {
  const haystacks = findings.map((f) => `${f.description ?? ''} ${f.location ?? ''}`.toLowerCase())
  for (const phrase of golden.any) {
    const needle = phrase.toLowerCase().trim()
    if (!needle) continue
    if (haystacks.some((h) => h.includes(needle))) return true
  }
  for (const pattern of golden.anyRegex ?? []) {
    let re: RegExp
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    if (haystacks.some((h) => re.test(h))) return true
  }
  return false
}

/** Severity-weighted recall. critical=3, major=2, minor=1. */
export function weightedRecall(
  fixture: FixtureCase,
  goldenMatches: boolean[],
): number {
  const total = fixture.goldenFindings.reduce((s, g) => s + severityWeight(g.severity), 0)
  if (total === 0) return 1
  const hit = fixture.goldenFindings.reduce(
    (s, g, i) => s + (goldenMatches[i] ? severityWeight(g.severity) : 0),
    0,
  )
  return hit / total
}

function severityWeight(severity: GoldenFinding['severity']): number {
  return severity === 'critical' ? 3 : severity === 'major' ? 2 : 1
}

/**
 * Precision proxy: fraction of emitted findings that match SOME golden in the
 * fixture. We have no human-labelled negatives, so unmatched findings are
 * treated as soft false positives. This punishes verbose auditors that pad
 * the report with vague filler. It does NOT punish the auditor for finding
 * real defects we haven't catalogued — that's a known limitation; the way
 * to lift it is to grow the fixture set.
 */
export function precision(
  fixture: FixtureCase,
  findings: DesignFinding[],
): number {
  if (findings.length === 0) return 1
  let matched = 0
  for (const finding of findings) {
    const haystack = `${finding.description ?? ''} ${finding.location ?? ''}`.toLowerCase()
    const matchedAny = fixture.goldenFindings.some((g) =>
      g.any.some((phrase) => phrase.length > 0 && haystack.includes(phrase.toLowerCase())),
    )
    if (matchedAny) matched++
  }
  return matched / findings.length
}

/**
 * Inter-pass orthogonality — 1 minus the mean pairwise cosine similarity of
 * finding sets across passes. Higher = more orthogonal = passes contribute
 * different findings. If only one pass ran, returns 1 (vacuously orthogonal).
 */
export function passOrthogonality(passFindings: Array<{ findings: DesignFinding[] }>): number {
  if (passFindings.length < 2) return 1
  const vectors = passFindings.map((p) => bagOfWords(p.findings))
  const sims: number[] = []
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sims.push(cosineSimilarity(vectors[i]!, vectors[j]!))
    }
  }
  if (sims.length === 0) return 1
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length
  return Math.max(0, Math.min(1, 1 - mean))
}

function bagOfWords(findings: DesignFinding[]): Map<string, number> {
  const bag = new Map<string, number>()
  for (const f of findings) {
    const text = `${f.description ?? ''} ${f.location ?? ''}`.toLowerCase()
    for (const tok of text.split(/[^a-z0-9]+/).filter((w) => w.length >= 4)) {
      bag.set(tok, (bag.get(tok) ?? 0) + 1)
    }
  }
  return bag
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let aMag = 0
  let bMag = 0
  for (const [, v] of a) aMag += v * v
  for (const [, v] of b) bMag += v * v
  for (const [k, v] of a) {
    const bv = b.get(k)
    if (bv) dot += v * bv
  }
  if (aMag === 0 || bMag === 0) return 0
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag))
}

/** Sample standard deviation. Returns 0 for n<2. */
export function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

/**
 * Build the multi-objective vector for a (variant, fixtures) result set.
 * Direction (in pareto.ts):
 *   recall              ↑ maximise
 *   precision           ↑ maximise
 *   passOrthogonality   ↑ maximise
 *   scoreStability      ↑ maximise (we report 1 - normalised stddev)
 *   cost                ↓ minimise (mean tokens)
 */
export function objectiveVectorFromTrials(
  fixture: FixtureCase,
  trials: TrialResult[],
): ObjectiveVector {
  const okTrials = trials.filter((t) => t.ok)
  const recallVals = okTrials.map((t) => weightedRecall(fixture, t.goldenMatches))
  const precisionVals = okTrials.map((t) => precision(fixture, t.findings))
  const scores = okTrials.map((t) => t.score)
  const costs = okTrials.map((t) => t.tokensUsed)
  const passOrths = okTrials
    .map((t) => (t.passFindings ? passOrthogonality(t.passFindings) : undefined))
    .filter((v): v is number => v !== undefined)

  const stabilityRaw = stddev(scores)
  // Normalise stddev onto a 0..1 axis: 0 stddev → stability=1; 3+ stddev → stability=0.
  const stability = Math.max(0, 1 - stabilityRaw / 3)

  return {
    recall: mean(recallVals),
    precision: mean(precisionVals),
    passOrthogonality: passOrths.length > 0 ? mean(passOrths) : 1,
    scoreStability: stability,
    cost: mean(costs),
  }
}

/** Aggregate per-fixture vectors into a single per-variant vector. */
export function aggregateObjectiveVectors(vectors: ObjectiveVector[]): ObjectiveVector {
  if (vectors.length === 0) {
    return { recall: 0, precision: 0, passOrthogonality: 0, scoreStability: 0, cost: 0 }
  }
  return {
    recall: mean(vectors.map((v) => v.recall)),
    precision: mean(vectors.map((v) => v.precision)),
    passOrthogonality: mean(vectors.map((v) => v.passOrthogonality)),
    scoreStability: mean(vectors.map((v) => v.scoreStability)),
    cost: mean(vectors.map((v) => v.cost)),
  }
}
