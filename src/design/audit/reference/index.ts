/**
 * L5 barrel — the public surface of the reference-grounded engine.
 *
 * Re-exports ONLY the entrypoints, the shared contracts, and the offline
 * authoring + eval helpers a consumer is meant to call. The L1-L3 internals
 * (pure cores, adapters, `engine/core`, `engine/wiring`) are deliberately NOT
 * re-exported here — callers reach the engine through `runReferenceRedesign`
 * (rich artifact) or `evaluateReferenceGrounded` (pipeline `PageAuditResult`),
 * not by importing a stage.
 */

// All shared types + boundary interfaces (RedesignArtifact, PageAuditResult,
// ReferenceGroundedConfig, Exemplar, TasteVerdict, …) flow from the one hub.
export * from './contracts.js'

// Rich library/CLI entry → RedesignArtifact.
export { runReferenceRedesign } from './run.js'
export type { RunReferenceRedesignOptions } from './run.js'

// Flagged STAGE-6 entry → PageAuditResult (drops into the existing pipeline).
export { evaluateReferenceGrounded } from './pipeline/evaluate-reference.js'
export type { EvaluateReferenceInput, ReferenceEvaluation } from './pipeline/evaluate-reference.js'

// Human-facing renderers for the redesign brief surfaced in the audit report:
// the full rich brief and a compact report-section projection, plus the shared
// slug used to name the brief file.
export { renderArtifactMarkdown, renderRedesignDirectionsSummary, artifactSlug } from './artifact/render.js'

// CLI plumbing: resolve `--reference <url|path>` into a ReferenceContext once.
export { resolveReferenceContext } from './reference-context.js'
export type { ResolveReferenceDeps, ResolveReferenceOptions } from './reference-context.js'

// Config: frozen defaults + the clamped operator-override merge.
export {
  resolveReferenceConfig,
  DEFAULT_REFERENCE_CONFIG,
  DEFAULT_RETRIEVE_WEIGHTS,
} from './config.js'
export type { ReferenceConfigOverrides } from './config.js'

// The text-model seam the entrypoints accept for `brain` (the real Brain satisfies it).
export type { ReferenceBrain } from './engine/wiring.js'

// Corpus access: the file-backed store + the offline authoring path.
export { createFileCorpusStore } from './corpus/store.js'
export { buildExemplar, ingestCorpus } from './corpus/build.js'
export type {
  BuildExemplarOptions,
  ExemplarClassifier,
  ExemplarClassifyInput,
  ExemplarClassification,
  IngestTarget,
  IngestCorpusOptions,
  IngestResult,
} from './corpus/build.js'

// Taste eval: corpus-vs-corpus agreement + generated-vs-reference metrics.
export { tasteAgreement, tasteMetricsFromVerdicts } from './eval/taste-core.js'
