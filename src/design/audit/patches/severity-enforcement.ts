/**
 * Severity enforcement — every major/critical finding MUST have ≥1 valid patch.
 *
 * Findings without patches are downgraded to `minor` with an explanatory note.
 * This runs as a post-processing step after patch validation.
 */

import type { Patch, DesignFinding } from '../score-types.js'

export interface EnforcementRecord {
  findingId: string
  fromSeverity: string
  toSeverity: 'minor'
  reason: string
}

export interface EnforcementResult {
  findings: DesignFinding[]
  downgraded: EnforcementRecord[]
}

/**
 * Given a list of findings and the set of valid patches (post-validation),
 * downgrade any major/critical finding that has no valid patch to `minor`.
 */
export function enforcePatchPolicy(
  findings: DesignFinding[],
  validPatchIds: Set<string>,
): EnforcementResult {
  const downgraded: EnforcementRecord[] = []

  const updated = findings.map(f => {
    if (f.severity !== 'major' && f.severity !== 'critical') return f

    const v2Finding = f as DesignFinding & { patches?: Patch[] }
    const patches = v2Finding.patches ?? []
    const hasValidPatch = patches.some(p => validPatchIds.has(p.patchId))

    if (hasValidPatch) return f

    downgraded.push({
      findingId: f.id,
      fromSeverity: f.severity,
      toSeverity: 'minor',
      reason: patches.length === 0
        ? 'no patches proposed'
        : 'all proposed patches failed validation (before not in snapshot, missing locator, or delta out of range)',
    })

    return {
      ...f,
      severity: 'minor' as const,
      suggestion: [
        f.suggestion,
        '[auto-downgraded: patch required for major/critical severity]',
      ]
        .filter(Boolean)
        .join(' '),
    }
  })

  return { findings: updated, downgraded }
}
