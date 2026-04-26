/**
 * Design audit v2 — type contract for the 8-layer architecture.
 *
 * RFC: docs/rfc/design-audit-world-class.md
 *
 * This file is the stable contract that every layer's implementation
 * builds against. It exists to let parallel implementation work proceed
 * without diverging interfaces. Editing this file mid-build is a coordinated
 * change; layers must update in lockstep.
 *
 * Invariants enforced by this contract:
 *   - Every score is a `DimensionScore` with `range` + `confidence`. No bare numbers.
 *   - Every finding with `severity in ['major','critical']` MUST have ≥1 `Patch`.
 *   - Every patch has both `target` (what changes) and `testThatProves` (how we verify).
 *   - Every classification carries explicit `ensembleConfidence` and `signalsAgreed`.
 *   - Every audit run can write a `PatchApplication` event for post-hoc attribution.
 *   - Pattern, ethics, modality types compose cleanly via shared `AppliesWhen`.
 */

import type {
  PageClassification,
  PageType,
  Maturity,
  DesignSystemTag,
  AppliesWhen as AppliesWhenV1,
  MeasurementBundle,
  DesignFinding as DesignFindingV1,
} from '../types.js'

// Re-export so consumers import only from v2/types.ts.
export type { PageClassification, PageType, Maturity, DesignSystemTag, MeasurementBundle }

// ─── Layer 1 · Multi-dimensional scoring ────────────────────────────────────

/**
 * The five universal dimensions. Every audit produces a DimensionScore for
 * each. The rollup is computed from these via per-page-type weights.
 */
export type Dimension =
  | 'product_intent'
  | 'visual_craft'
  | 'trust_clarity'
  | 'workflow'
  | 'content_ia'

export const DIMENSIONS: readonly Dimension[] = [
  'product_intent',
  'visual_craft',
  'trust_clarity',
  'workflow',
  'content_ia',
] as const

export type ConfidenceLevel = 'high' | 'medium' | 'low'

export interface DimensionScore {
  /** 1-10 integer score on the dimension. */
  score: number
  /** Self-reported uncertainty range. `range[0] <= score <= range[1]`. */
  range: [number, number]
  /** Auditor's confidence in the score. */
  confidence: ConfidenceLevel
  /** One-sentence assessment grounded in observable evidence. */
  summary: string
  /** Stable ids of top findings driving this score. References `DesignFinding.id`. */
  primaryFindings: string[]
}

export interface RollupScore {
  /** Weighted aggregate of `Record<Dimension, DimensionScore>`. 1-10 number, can be fractional. */
  score: number
  /** Aggregate uncertainty range. */
  range: [number, number]
  /** Aggregate confidence. Conservative — `low` if any dim is `low`. */
  confidence: ConfidenceLevel
  /** Human-readable formula, e.g. "saas-app: product*0.35 + workflow*0.30 + ...". */
  rule: string
  /** Per-dimension weight that produced this rollup. Must sum to 1.0 ± 1e-6. */
  weights: Record<Dimension, number>
}

// ─── Ensemble classifier ────────────────────────────────────────────────────

export type ClassifierSource = 'url-pattern' | 'dom-heuristic' | 'llm'

export interface ClassifierSignal {
  source: ClassifierSource
  type: PageType
  /** 0..1, source-specific. */
  confidence: number
  /** Why this signal voted this type. Logged for debugging. */
  rationale: string
}

export interface EnsembleClassification extends PageClassification {
  /** Every signal that voted on this classification. */
  signals: ClassifierSignal[]
  /** True if all signals agreed on `type`. */
  signalsAgreed: boolean
  /** Aggregated 0..1 confidence after ensemble vote. */
  ensembleConfidence: number
  /** Signals that disagreed with the final type, if any. */
  dissent?: { source: ClassifierSource; type: PageType }[]
  /** True if Layer 3 (first-principles) mode was triggered. */
  firstPrinciplesMode: boolean
}

/**
 * DOM-derived signals used by the heuristic classifier. Captured once during
 * the page-load phase, fed to the ensemble vote, and emitted into telemetry.
 */
export interface DomHeuristics {
  formCount: number
  inputCount: number
  tableRowCount: number
  chartCount: number
  navItems: number
  hasFooterLinks: boolean
  hasHeroSection: boolean
  hasSidebar: boolean
  paragraphCount: number
  codeBlockCount: number
}

// ─── Layer 2 · Patch primitives ─────────────────────────────────────────────

/**
 * Where a patch applies. At least one of `cssSelector | filePath | componentName`
 * MUST be set. The combination determines how an agent applies it.
 */
export interface PatchTarget {
  /** Source file path when known via component scan. */
  filePath?: string
  /** Component name when known (e.g. 'Sidebar', 'PrimaryButton'). */
  componentName?: string
  /** CSS selector — fallback when filePath unknown. */
  cssSelector?: string
  /** Patch scope. Determines applicability check. */
  scope: 'tsx' | 'jsx' | 'css' | 'tailwind' | 'module-css' | 'styled-component' | 'structural' | 'html'
}

export interface PatchDiff {
  /**
   * Exact substring being replaced. Validators MUST verify `before` is a
   * substring of the page snapshot or source file at apply time. If `before`
   * is not found, the patch is rejected (no fuzzy apply).
   */
  before: string
  /** Replacement text. */
  after: string
  /**
   * When `target.filePath` is known, the unified diff format an agent can
   * pipe to `git apply`. Optional; `before`/`after` is the canonical form.
   */
  unifiedDiff?: string
}

export type PatchTestKind =
  | 'storybook'
  | 'a11y-rule'
  | 'visual-snapshot'
  | 'unit'
  | 'rerun-audit'
  | 'manual'

export interface PatchTest {
  kind: PatchTestKind
  /** Human-readable description of what proves the patch worked. */
  description: string
  /** Optional CLI command an agent can invoke to verify (e.g. `pnpm vitest <name>`). */
  command?: string
}

export type PatchRollbackKind = 'git-revert' | 'css-disable' | 'manual'

export interface PatchRollback {
  kind: PatchRollbackKind
  /** Optional human-readable rollback instruction. */
  instruction?: string
}

/**
 * A `Patch` is the agent-actionable unit. Layer 2 mandates ≥1 patch on every
 * major/critical finding. Findings without patches downgrade to minor.
 */
export interface Patch {
  /** Stable id derived from finding hash + target. Same patch across tenants → same id. */
  patchId: string
  /** The finding this patch fixes. */
  findingId: string
  /** Patch scope — page/section/component/system, drives ROI weighting. */
  scope: 'page' | 'section' | 'component' | 'system'
  target: PatchTarget
  diff: PatchDiff
  testThatProves: PatchTest
  rollback: PatchRollback
  /** The dimension the auditor predicts this patch will move + by how much. */
  estimatedDelta: { dim: Dimension; delta: number }
  /**
   * Confidence in `estimatedDelta`, calibrated against fleet outcomes (Layer 4).
   * 'untested' means no fleet data yet; 'high' means N≥30 with replication ≥0.7.
   */
  estimatedDeltaConfidence: ConfidenceLevel | 'untested'
  /**
   * If this patch matches a known fleet pattern (Layer 5), the matched pattern
   * id. Surfaced by the auditor so agents prefer evidence-backed patches.
   */
  matchedPatternId?: string
}

/**
 * Updated `DesignFinding` shape — extends v1 with stable id, dimension link,
 * mandatory patches for major/critical, optional pattern match.
 */
export interface DesignFinding extends DesignFindingV1 {
  /** Stable id, used by `DimensionScore.primaryFindings`. */
  id: string
  /** Which dimension this finding affects. */
  dimension: Dimension
  /** Agent-actionable patches. Required (≥1) when severity is major or critical. */
  patches: Patch[]
  /**
   * Discriminator for finding kind. `polish` findings cap at impact 6;
   * `job` findings can go to 10; `measurement` findings come from axe/contrast.
   * Set this so ROI ranking auto-prioritizes job over polish.
   */
  kind: 'polish' | 'job' | 'measurement'
}

// ─── Layer 3 · First-principles fallback ────────────────────────────────────

/**
 * Triggered when ensemble confidence is low or no fixture matches the page
 * structure. Auditor scores against 5 universal principles and emits a
 * novel-pattern record for fleet mining.
 */
export interface NovelPatternObservation {
  observationId: string
  capturedAt: string
  /** What was distinctive about this page structurally. */
  observed: string
  /** Closest existing classification, with low confidence. */
  closestType: PageType
  closestConfidence: number
  /** Page snapshot reference for later mining. */
  snapshotKey?: string
  /** URL or fixture id. */
  pageRef: string
}

// ─── Layer 4 · Outcome attribution ──────────────────────────────────────────

/**
 * One application of a patch. Emitted by the `bad design-audit ack-patch`
 * subcommand or auto-detected by the `--evolve` loop.
 */
export interface PatchApplication {
  applicationId: string
  patchId: string
  appliedAt: string
  appliedBy: string // 'agent:claude-code' | 'agent:codex' | 'human' | 'css-injection' | ...
  /** The audit run that proposed the patch. */
  preAuditRunId: string
  /** The audit run after the patch was applied. May be null until re-audit. */
  postAuditRunId?: string
  /** Auditor's prediction at apply time. */
  predicted: { dim: Dimension; delta: number }
  /** Measured delta after re-audit. Populated when postAuditRunId resolves. */
  observed?: { dim: Dimension; delta: number }
  /**
   * Agreement metric: 1.0 = perfect prediction, 0 = orthogonal, negative = wrong direction.
   * `(observed.delta * predicted.delta) / max(|observed.delta|, |predicted.delta|, 1)`
   */
  agreementScore?: number
}

/**
 * Aggregated reliability across all applications of a patch (joined on
 * `patchHash = hash(diff.before, diff.after, scope)`). Surfaces in audit
 * output as `Patch.estimatedDeltaConfidence` upgrade.
 */
export interface PatchReliability {
  patchHash: string
  applications: number
  meanPredictedDelta: number
  meanObservedDelta: number
  /** % of applications where observed >= 0.5 * predicted. */
  replicationRate: number
  recommendation: 'recommended' | 'neutral' | 'antipattern'
  /** Distinct tenant count. Below 5 → 'untested' confidence. */
  sampleTenants: number
}

// ─── Layer 5 · Pattern library ──────────────────────────────────────────────

/**
 * A curated known-good design pattern, mined from accumulated PatchApplication
 * data once N≥30 across ≥5 distinct tenants with ≥0.7 replication.
 */
export interface Pattern {
  patternId: string
  /** Free-form category name, e.g. 'leaderboard', 'empty-state', 'pricing-table'. */
  category: string
  classification: { type: PageType; tags: string[] }
  scaffold: PatternScaffold
  scores: { whenFollowed: Record<Dimension, number> }
  fleetEvidence: PatternFleetEvidence
  /** Fixture ids that exemplify this pattern. */
  fixtures: string[]
}

export interface PatternScaffold {
  description: string
  referenceTsx?: string
  referenceCss?: string
  /** Concrete decisions that make the pattern work, e.g. 'criterion in header'. */
  keyDecisions: string[]
}

export interface PatternFleetEvidence {
  applications: number
  /** % where adopting this pattern delivered the predicted dim delta. */
  successRate: number
  medianDimDelta: Record<Dimension, number>
  /** Distinct tenants. ≥5 required for promotion to 'recommended'. */
  sampleTenants: number
}

export interface PatternQuery {
  category?: string
  pageType?: PageType
  /** "I'm scoring 4 on product_intent — show me patterns that lift it." */
  weakDimension?: Dimension
  minApplications?: number
  minSuccessRate?: number
}

export interface PatternMatch {
  pattern: Pattern
  matchConfidence: number
  expectedDelta: Record<Dimension, number>
  /** How to adapt this pattern to the current page. */
  applicationGuidance: string
}

// ─── Layer 6 · Composable predicates (extends AppliesWhen) ──────────────────

export type AudienceTag =
  | 'developer'
  | 'clinician'
  | 'analyst'
  | 'consumer'
  | 'admin'
  | 'kids'
  | 'enterprise-buyer'
  | 'creator'

export type ModalityTag = 'desktop' | 'tablet' | 'mobile' | 'tv' | 'kiosk'

export type RegulatoryContextTag = 'hipaa' | 'gdpr' | 'sox' | 'pci-dss' | 'coppa' | 'wcag-aaa'

export type AudienceVulnerabilityTag =
  | 'patient-facing'
  | 'minor-facing'
  | 'high-stakes-financial'
  | 'crisis-context'

/**
 * v2 predicate set. Extends v1 with audience/modality/regulatoryContext/
 * audienceVulnerability so a pediatric medical app on tablet for clinicians
 * loads multiple fragments simultaneously.
 */
export interface AppliesWhen extends AppliesWhenV1 {
  audience?: AudienceTag[]
  modality?: ModalityTag[]
  regulatoryContext?: RegulatoryContextTag[]
  audienceVulnerability?: AudienceVulnerabilityTag[]
}

// ─── Layer 7 · Domain ethics gate ───────────────────────────────────────────

export type EthicsCategory = 'medical' | 'kids' | 'finance' | 'legal' | 'accessibility' | 'crisis'

export type EthicsSeverity = 'critical-floor' | 'major-floor'

export interface EthicsRule {
  ruleId: string
  category: EthicsCategory
  severity: EthicsSeverity
  appliesWhen: AppliesWhen
  detector: EthicsDetector
  remediation: string
  /** Citation to regulation or standard, e.g. 'FDA 21 CFR 201.57'. */
  citation?: string
}

export type EthicsDetector =
  | { kind: 'pattern-absent'; pattern: string }
  | { kind: 'pattern-present'; pattern: string }
  | { kind: 'llm-classifier'; llmCheck: string }

export interface EthicsViolation {
  ruleId: string
  detected: true
  severity: EthicsSeverity
  /** Rollup ceiling enforced by this violation. critical-floor → 4; major-floor → 6. */
  rollupCap: number
  remediation: string
  citation?: string
}

// ─── Layer 8 · Modality adapters ────────────────────────────────────────────

export type Modality = 'html' | 'ios' | 'android' | 'terminal' | 'voice'

export interface ModalityInput {
  /** Modality-specific entry point — URL for HTML, app bundle for iOS, etc. */
  entryPoint: string
  /** Optional flow specification when capturing multiple surfaces. */
  flow?: string[]
}

/**
 * Per-modality measurement bundle — analogous to the existing HTML
 * MeasurementBundle (axe + contrast). Modality-specific implementations
 * provide their own a11y/contrast equivalents.
 */
export interface SurfaceMeasurements {
  modality: Modality
  /** A11y violations — modality-specific shape. */
  a11y?: unknown
  /** Contrast or readability check — modality-specific. */
  contrast?: unknown
  /** Modality-specific measurements (haptic, latency, etc.). */
  extra?: Record<string, unknown>
}

export interface SurfaceRecord {
  /** URL for HTML; screen name for native; turn id for voice. */
  identifier: string
  measurements: SurfaceMeasurements
  snapshot: string
  screenshot?: string
}

export interface Evidence {
  modality: Modality
  surfaces: SurfaceRecord[]
  /** Roll-up of per-surface measurements for backwards compat with v1 pipeline. */
  measurements: MeasurementBundle
  /** Concatenated snapshot for LLM consumption. */
  snapshot: string
  screenshot?: string
}

export interface ModalityAdapter {
  modality: Modality
  capture(input: ModalityInput): Promise<Evidence>
}

// ─── AuditResult v2 — the top-level output ──────────────────────────────────

export interface AuditResult_v2 {
  schemaVersion: 2
  /** Run id for telemetry / attribution correlation. */
  runId: string
  /** Page reference (URL for HTML; bundle id for native; etc.). */
  pageRef: string
  classification: EnsembleClassification
  /** Per-dimension scores, ALWAYS all 5 dimensions. */
  scores: Record<Dimension, DimensionScore>
  rollup: RollupScore
  /** Findings + patches. Includes deterministic measurements (axe, contrast). */
  findings: DesignFinding[]
  /** Top-N findings ranked by ROI. References `findings[*].id`. */
  topFixes: string[]
  measurements: MeasurementBundle
  ethicsViolations: EthicsViolation[]
  /** Patterns matched against the page (Layer 5). May be empty. */
  matchedPatterns: PatternMatch[]
  /** When first-principles mode triggered (Layer 3). May be undefined. */
  novelPattern?: NovelPatternObservation
  /** Modality (Layer 8). HTML for v1 compat. */
  modality: Modality
  /** Provenance. */
  evaluatedAt: string
  promptHash: string
  rubricHash: string
  /** LLM token usage across passes. */
  tokensUsed?: number
  /** Ensemble of audit passes that ran (deep / max / single). */
  passes: string[]
  error?: string
}

// ─── CLI / runtime hints ────────────────────────────────────────────────────

/**
 * Operator-supplied hints. None override the classifier outright; they bias
 * the ensemble toward a result. If a hint disagrees with the classifier's
 * final type with high confidence, a warning surfaces.
 */
export interface AuditRuntimeHints {
  rubricHint?: PageType
  audience?: AudienceTag[]
  modality?: ModalityTag[]
  regulatoryContext?: RegulatoryContextTag[]
  /** Tenant id for cross-tenant attribution + ethics rule overrides. */
  tenantId?: string
}
