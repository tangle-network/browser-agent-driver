// Type-only — erased at runtime; the reference engine is loaded lazily, and only
// when a reference-grounded run is requested (default audits never touch it).
import type {
  EvalMode,
  ReferenceContext,
  Exemplar,
  ReferenceGroundedConfig,
} from '../reference/index.js'

/**
 * The reference-grounded eval bundle, acquired ONCE and spread into every
 * `auditOnePage` call site (including the evolve re-audit loops) so a
 * `--reference-grounded` run never silently falls back to v1 scoring on any path.
 * Default OFF carries only `evalMode:'v1'`, leaving those call sites byte-identical.
 */
export type ReferenceCommonOpts = {
  evalMode: EvalMode
  reference?: ReferenceContext
  corpus?: Exemplar[]
  referenceConfig?: ReferenceGroundedConfig
}
