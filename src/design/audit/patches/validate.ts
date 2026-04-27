/**
 * Patch validator — given a parsed patch and the page snapshot text, verify
 * that the patch is grounded and applyable.
 *
 * Rules:
 *   - `diff.before` must appear as a case-sensitive substring of the snapshot.
 *     Agents apply patches literally; a hallucinated `before` is unfixable.
 *   - `target` must carry at least one locator (cssSelector | filePath |
 *     componentName). Without one the agent has nowhere to apply.
 *   - `estimatedDelta.delta` must be in [-3, 3]. Larger claims are almost
 *     always over-confident on a 1–10 scale.
 */

import type { Patch } from '../score-types.js'

export type ValidationReason =
  | 'before-not-in-snapshot'
  | 'target-missing-locator'
  | 'estimated-delta-out-of-range'
  | 'before-empty'

export interface ValidationResult {
  valid: boolean
  reasons: ValidationReason[]
}

const DELTA_MIN = -3
const DELTA_MAX = 3

/**
 * Validate a single patch against a page snapshot. Reports all issues in one
 * pass so callers can surface every problem to the agent at once.
 *
 * Snapshot-anchoring rule: `diff.before` must appear verbatim in the page
 * snapshot ONLY when the patch targets the snapshot itself — i.e. `target.scope`
 * is `html` or `structural`. CSS / TSX / Tailwind patches modify source files
 * the audit can't see, so the snapshot check would always fail for them. The
 * agent verifies those patches at apply-time against the actual source file.
 */
export function validatePatch(patch: Patch, snapshot: string): ValidationResult {
  const reasons: ValidationReason[] = []
  const { target, diff, estimatedDelta } = patch

  if (!target.cssSelector && !target.filePath && !target.componentName) {
    reasons.push('target-missing-locator')
  }

  const requiresSnapshotMatch = target.scope === 'html' || target.scope === 'structural'

  if (diff.before.length === 0) {
    reasons.push('before-empty')
  } else if (requiresSnapshotMatch && !snapshot.includes(diff.before)) {
    reasons.push('before-not-in-snapshot')
  }

  if (
    estimatedDelta.delta < DELTA_MIN ||
    estimatedDelta.delta > DELTA_MAX ||
    !Number.isFinite(estimatedDelta.delta)
  ) {
    reasons.push('estimated-delta-out-of-range')
  }

  return { valid: reasons.length === 0, reasons }
}

/**
 * Validate a list of patches and partition into valid / invalid.
 */
export function validatePatches(
  patches: Patch[],
  snapshot: string,
): { valid: Patch[]; invalid: Array<{ patch: Patch; reasons: ValidationReason[] }> } {
  const valid: Patch[] = []
  const invalid: Array<{ patch: Patch; reasons: ValidationReason[] }> = []
  for (const patch of patches) {
    const result = validatePatch(patch, snapshot)
    if (result.valid) valid.push(patch)
    else invalid.push({ patch, reasons: result.reasons })
  }
  return { valid, invalid }
}
