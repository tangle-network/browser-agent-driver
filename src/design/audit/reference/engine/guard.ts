/**
 * Fail-closed proceed/abort guard — the PURE gate that keeps the engine from
 * shipping a default-looking run mislabelled as reference-grounded.
 *
 * A reference-grounded run is only meaningful when it has something concrete to
 * ground against: at least one retrieved exemplar, OR an operator-supplied
 * `--reference`. With neither, `decideProceed` returns an explicit abort reason
 * instead of letting the engine emit an ungrounded artifact that pretends to be
 * reference-grounded. There is no fabricated success path here — an absent
 * signal is treated as a blocker, never silently as "passed".
 *
 * Pure and deterministic: no IO, no LLM, no clock.
 */

import type { ReferenceContext } from '../contracts.js'

/** Inputs to the proceed decision. All counts are post-retrieval. */
export interface GuardInput {
  /** Number of exemplars loaded into the in-memory corpus for this run. */
  corpusSize: number
  /** Number of exemplars the matcher actually retrieved for this page. */
  retrieved: number
  /** Operator-supplied reference, resolved once; stands in for the corpus. */
  reference?: ReferenceContext
}

/**
 * Discriminated result: proceed, or abort with a human-readable reason. The
 * reason is surfaced to the operator and recorded — never swallowed.
 */
export type ProceedDecision = { ok: true } | { ok: false; reason: string }

/** A finite, strictly-positive count. Non-finite / negative ⇒ treated as zero. */
function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0
}

/**
 * Decide whether a reference-grounded run may proceed.
 *
 * An operator reference short-circuits to `ok` (it is itself the grounding
 * target, so an empty corpus is fine). Otherwise both a non-empty corpus AND a
 * non-empty retrieval are required; either being empty is a terminal blocker
 * with a distinct reason so the operator knows which precondition failed.
 */
export function decideProceed(input: GuardInput): ProceedDecision {
  if (input.reference) return { ok: true }

  if (!positive(input.corpusSize)) {
    return {
      ok: false,
      reason:
        'reference-grounded run requires a non-empty exemplar corpus or a --reference; the corpus is empty',
    }
  }

  if (!positive(input.retrieved)) {
    return {
      ok: false,
      reason:
        'reference-grounded run retrieved 0 exemplars for this page type and no --reference was supplied; nothing to ground against',
    }
  }

  return { ok: true }
}
