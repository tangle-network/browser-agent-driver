/**
 * ROI scoring + cross-page systemic detection.
 *
 * Pure functions, no LLM calls. Easy to unit test.
 *
 * The LLM produces impact/effort/blast for each finding (in turn 3 of the
 * audit pipeline). This module:
 *   1. Computes the final `roi` score from those raw values.
 *   2. Detects findings that appear on multiple pages and elevates their
 *      blast to 'system' (with the count of affected pages).
 *   3. Provides sort + selection helpers for "top fixes" surfacing.
 */

import type { DesignFinding } from '../../types.js'

/**
 * Multipliers for converting blast scope into a leverage factor.
 *
 * A system-level fix touches every page that uses that component / token,
 * so its impact is multiplied. The effect on ROI is asymmetric — these
 * weights are deliberately conservative; we want ROI to favor systemic
 * fixes without completely drowning out high-impact page-specific issues.
 */
const BLAST_WEIGHT: Record<NonNullable<DesignFinding['blast']>, number> = {
  page: 1,
  section: 1.25,
  component: 1.75,
  system: 2.5,
}

/** Default values when the LLM didn't produce ROI fields. */
const DEFAULT_IMPACT = 5
const DEFAULT_EFFORT = 5
const DEFAULT_BLAST: NonNullable<DesignFinding['blast']> = 'page'

/**
 * Compute the ROI score for a single finding from its impact/effort/blast.
 * Returns a positive number — higher means "fix this first."
 *
 * Formula: (impact * blastWeight) / effort
 *
 * Edge cases:
 *   - Missing fields → use defaults (impact=5, effort=5, blast=page) → roi = 1.0
 *   - effort = 0 is treated as 1 to avoid division by zero
 */
export function computeRoi(finding: DesignFinding): number {
  const impact = finding.impact ?? DEFAULT_IMPACT
  const effort = Math.max(1, finding.effort ?? DEFAULT_EFFORT)
  const blast = finding.blast ?? DEFAULT_BLAST
  const weight = BLAST_WEIGHT[blast]
  return Math.round(((impact * weight) / effort) * 100) / 100
}

/**
 * Annotate every finding with its computed ROI in place.
 * Returns the same array for chaining.
 */
export function annotateRoi(findings: DesignFinding[]): DesignFinding[] {
  for (const f of findings) {
    f.roi = computeRoi(f)
  }
  return findings
}

/**
 * Cross-page systemic detection.
 *
 * Groups findings from across all audited pages by `(category, normalized_description)`.
 * Any group that appears on 2+ distinct pages becomes a single canonical
 * finding with `blast: 'system'` and `pageCount` set, replacing the duplicates.
 *
 * Normalization: lowercased, first 80 chars only, trimmed.
 * Conservative on purpose — better to under-merge than to merge unrelated findings.
 *
 * @param perPageFindings - array of finding arrays, one per audited page
 * @returns flat array of findings, with cross-page duplicates collapsed
 */
export function detectSystemicFindings(
  perPageFindings: DesignFinding[][],
): DesignFinding[] {
  // Map of normalized key → { canonical finding, set of page indices it appeared on }
  const groups = new Map<string, { canonical: DesignFinding; pages: Set<number> }>()
  // Findings that don't dedupe stay in their original page bucket
  const singletonsByPage: DesignFinding[][] = perPageFindings.map(() => [])

  for (let pageIdx = 0; pageIdx < perPageFindings.length; pageIdx++) {
    const findings = perPageFindings[pageIdx]
    for (const finding of findings) {
      const key = normalizeFindingKey(finding)
      const existing = groups.get(key)
      if (existing) {
        existing.pages.add(pageIdx)
      } else {
        groups.set(key, {
          canonical: { ...finding },
          pages: new Set([pageIdx]),
        })
      }
    }
  }

  // For each group: if it appears on 2+ pages, promote to systemic.
  // Otherwise, return it back to its original page bucket as a singleton.
  const systemic: DesignFinding[] = []
  for (const { canonical, pages } of groups.values()) {
    if (pages.size >= 2) {
      const promoted: DesignFinding = {
        ...canonical,
        blast: 'system',
        pageCount: pages.size,
        description: `[appears on ${pages.size} pages] ${canonical.description}`,
      }
      promoted.roi = computeRoi(promoted)
      systemic.push(promoted)
    } else {
      const onlyPage = pages.values().next().value
      if (onlyPage !== undefined) {
        singletonsByPage[onlyPage].push(canonical)
      }
    }
  }

  // Flatten: systemic findings first (higher ROI), then per-page singletons
  const flat = [...systemic]
  for (const page of singletonsByPage) flat.push(...page)
  return flat
}

/**
 * Normalize a finding into a key for cross-page grouping.
 *
 * Uses (category, description-prefix) — conservative enough to avoid
 * merging unrelated findings, loose enough to catch the same issue
 * worded slightly differently across pages.
 */
function normalizeFindingKey(finding: DesignFinding): string {
  const desc = (finding.description ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${finding.category}|${desc}`
}

/**
 * Pick the top N findings by ROI (descending).
 * Stable: ties broken by severity (critical > major > minor), then by description.
 */
export function topByRoi(findings: DesignFinding[], n: number): DesignFinding[] {
  const SEVERITY_RANK: Record<DesignFinding['severity'], number> = {
    critical: 0,
    major: 1,
    minor: 2,
  }
  return [...findings]
    .sort((a, b) => {
      const roiA = a.roi ?? computeRoi(a)
      const roiB = b.roi ?? computeRoi(b)
      if (roiB !== roiA) return roiB - roiA
      const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      if (sevDiff !== 0) return sevDiff
      return a.description.localeCompare(b.description)
    })
    .slice(0, n)
}
