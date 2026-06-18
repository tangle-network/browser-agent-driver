/**
 * Reference-Grounded Art Director — shared contracts.
 *
 * This is the SINGLE source of truth for every type and module-boundary
 * interface the reference engine passes between stages. It holds ZERO runtime
 * logic, ZERO constants, and ZERO default values — only `type`/`interface`
 * declarations and re-exports. Keeping it logic-free is what prevents it from
 * becoming a god module that every core imports for behaviour rather than shape.
 *
 * Design rules encoded here:
 *  - Every cross-stage hop is typed by a record in this file, so no module
 *    reaches into another's internals.
 *  - Every IO / LLM / browser boundary is expressed as a NARROW, single-purpose
 *    interface (DesignDnaExtractor, CorpusReader, CorpusWriter, ExemplarMatcher,
 *    EmbeddingProvider, RedesignGenerator, TasteJudge, DirectionRanker). Cores
 *    and the orchestrator depend on these interfaces, never on concrete
 *    adapters. There is deliberately NO single "God" interface — each boundary
 *    is its own contract, and read/write surfaces are split (CorpusReader vs
 *    CorpusWriter) so the runtime audit path can never reach authoring mutators.
 *  - The engine emits the EXISTING audit contracts (DesignFinding,
 *    PageAuditResult, …) verbatim by re-exporting them, never redefining them,
 *    so the closed enums stay authoritative and stages 7-9 of the v1 pipeline
 *    keep working unchanged.
 *
 * Units are noted inline (px, ms, 0-1 ratios) so downstream math is unambiguous.
 */

import type {
  DesignTokens,
  ColorToken,
  ViewportTokens,
  TypeScaleEntry,
  FontFamily,
  DesignFinding,
  DesignSystemScore,
} from '../../../types.js'
import type {
  PageClassification,
  PageType,
  MeasurementBundle,
  PageAuditResult,
} from '../types.js'
import type { Dimension, DimensionScore } from '../score-types.js'

// Re-export the canonical contracts so engine modules import shapes from ONE
// place and never redefine the authoritative enums (DesignFinding.category,
// DesignFinding.severity, PageType, …).
export type {
  DesignTokens,
  ColorToken,
  ViewportTokens,
  TypeScaleEntry,
  FontFamily,
  DesignFinding,
  DesignSystemScore,
} from '../../../types.js'
export type {
  PageClassification,
  PageType,
  MeasurementBundle,
  PageAuditResult,
} from '../types.js'
// The 5-dimension product-quality scoring taxonomy (product_intent, visual_craft,
// trust_clarity, workflow, content_ia) and its rich per-dim shape. This — NOT the
// flat 8-number DesignSystemScore — is what stage 8's `precomputedScores` consumes,
// so the engine's quality leg is keyed by `Dimension` and produces `DimensionScore`s.
export type { Dimension, DimensionScore } from '../score-types.js'

// ── Design DNA ───────────────────────────────────────────────────────────────
//
// DesignDNA is the structured, browser-free identity of a page or exemplar. It
// is a LOSSY NORMALISATION of DesignTokens (colors → roles, type → scale+role,
// spacing → rhythm) — it deliberately does not round-trip back to tokens. All
// DNA-level math (delta, descriptor, retrieval) operates at this altitude; raw
// token-level math stays on DesignTokens. The two never get conflated.

/**
 * Visual density of a layout, derived from whitespace ratio + component counts.
 * Shared by SpacingRhythm and LayoutGrammar so density is computed once.
 */
export type Density = 'sparse' | 'balanced' | 'dense'

/**
 * One semantic step in a page's type scale.
 */
export interface TypeStepDNA {
  /** Rendered font size in CSS px. */
  fontSizePx: number
  /** Numeric font weight (100-900). */
  weight: number
  /** Unitless line-height (e.g. 1.5), or the px line-height ÷ fontSizePx. */
  lineHeight: number
  /** Font family this step renders in. */
  family: string
  /** Semantic role inferred from size/usage. */
  role: 'display' | 'heading' | 'body' | 'caption' | 'label'
}

/**
 * A font family and the role(s) it plays in the design.
 */
export interface FontRoleDNA {
  family: string
  /** Coarse role classification carried through from DesignTokens.typography. */
  role: 'heading' | 'body' | 'mono' | 'display'
  /** Numeric weights observed for this family. */
  weights: number[]
}

/**
 * The normalised type system: an ordered scale plus the modular ratio between
 * adjacent steps (if one is detectable).
 */
export interface TypeScaleDNA {
  /** Steps sorted ascending by fontSizePx. */
  steps: TypeStepDNA[]
  /** Geometric ratio between adjacent steps (e.g. 1.25), or undefined if irregular. */
  ratio?: number
  /** Families and their roles. */
  families: FontRoleDNA[]
}

/**
 * Semantic color role. Mirrors ColorToken.cluster so role mapping is a 1:1
 * carry-through from the already-clustered tokens, never a re-clustering.
 */
export type ColorRole =
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'neutral'
  | 'background'
  | 'border'

/**
 * The normalised color system: hex values grouped by semantic role.
 */
export interface ColorSystemDNA {
  /** Hex strings per role; a role may carry several shades. */
  roles: Record<ColorRole, string[]>
  /**
   * Minimum AA contrast ratio observed on body text, when measurements are
   * available. Lets the judge reason about legibility without re-measuring.
   */
  contrastFloor?: number
}

/**
 * The spacing rhythm: a base grid unit and the discrete spacing scale.
 */
export interface SpacingRhythm {
  /** Detected base grid unit in px (4/5/6/8/10), or undefined if no clear grid. */
  baseUnit?: number
  /** Distinct spacing values in px, sorted ascending. */
  steps: number[]
  /** Visual density of spacing. */
  density: Density
}

/**
 * The corner-radius scale, in px, sorted ascending.
 */
export interface RadiiScale {
  steps: number[]
}

/**
 * Motion signature: durations, easings, and any detected animation libraries.
 */
export interface MotionDNA {
  /** Transition/animation durations in ms. */
  durationsMs: number[]
  /** CSS easing functions / named curves observed. */
  easings: string[]
  /** Detected animation libraries (gsap, framer-motion, lottie, …). */
  libraries: string[]
}

/**
 * Layout grammar: the macro structure of the page.
 */
export interface LayoutGrammar {
  /** Dominant column count of the primary content grid, if detectable. */
  columns?: number
  /** Base grid unit in px (carried from ViewportTokens.gridBaseUnit). */
  gridBaseUnit?: number
  /** Fraction of viewport that is whitespace, 0-1. */
  whitespaceRatio?: number
  /** Visual density of the layout. */
  density: Density
  /**
   * Free-form structural archetype label (e.g. "hero+feature-grid",
   * "split-screen", "data-table-shell"). A hint for retrieval/generation, not a
   * closed enum — novel layouts get a novel label rather than a forced bucket.
   */
  archetype: string
}

/**
 * Component pattern counts — how many distinct button/input/card/nav patterns
 * the page uses. High counts signal an inconsistent system.
 */
export interface ComponentPatternDNA {
  buttons: number
  inputs: number
  cards: number
  nav: number
}

/**
 * The full structured identity of one page or exemplar. Produced purely from a
 * DesignTokens record (+ optional MeasurementBundle) — no browser, no LLM.
 */
export interface DesignDNA {
  url: string
  /** ISO timestamp of capture. */
  capturedAt: string
  type: TypeScaleDNA
  color: ColorSystemDNA
  spacing: SpacingRhythm
  radii: RadiiScale
  motion: MotionDNA
  layout: LayoutGrammar
  components: ComponentPatternDNA
  /**
   * Deterministic measurement signals folded in when available. Absent =
   * "no signal" (never treat as "passed").
   */
  signals?: {
    /** AA contrast pass rate, 0-1. */
    contrastAaPassRate?: number
    /** Count of critical/serious a11y violations. */
    a11yBlockingCount?: number
  }
}

/**
 * Structural delta between two DNAs (audited page vs winner, or page vs
 * reference). Computed PURELY over DesignDNA fields — it does NOT diff raw
 * DesignTokens (a different altitude). Used to ground judge feedback and to
 * mint "gap" findings.
 */
export interface DnaDelta {
  /** Color roles added/removed/changed between the two systems. */
  color: { added: string[]; removed: string[]; changed: string[] }
  /** Type-scale changes (steps added/removed, ratio shift). */
  type: { stepsAdded: number; stepsRemoved: number; ratioDelta?: number }
  /** Spacing rhythm changes. */
  spacing: { baseUnitFrom?: number; baseUnitTo?: number; densityChanged: boolean }
  /** Component pattern count deltas. */
  components: { buttons: number; inputs: number; cards: number; nav: number }
  /** Human-readable one-line summary of the most salient differences. */
  summary: string
}

// ── DNA extraction boundary ───────────────────────────────────────────────────

/**
 * Options for turning a live URL (or a ripped local copy) into a DnaCapture.
 */
export interface ExtractPageDnaOptions {
  /** Live URL or `file://` path to a ripped index.html. */
  url: string
  headless?: boolean
  /** Where downloaded assets / screenshots land. */
  outputDir?: string
  /**
   * Deterministic measurements already gathered for this page, folded into the
   * DNA signals. Optional so the corpus-authoring path (no audit measurements)
   * still works.
   */
  measurements?: MeasurementBundle
}

/**
 * The output of a page→DNA extraction: the DNA plus the raw tokens and
 * screenshots it derived from (kept so callers that need token-altitude data —
 * e.g. an optional rendered before/after — don't re-extract).
 */
export interface DnaCapture {
  dna: DesignDNA
  tokens: DesignTokens
  /** Per-viewport screenshot file paths, keyed by viewport name. */
  screenshotPaths: Record<string, string>
  outputDir: string
}

/**
 * IO boundary: turn a URL into a DnaCapture. The shipped adapter reuses
 * `extractDesignTokens` then the pure `toDesignDNA`; tests inject a fake.
 */
export interface DesignDnaExtractor {
  extract(opts: ExtractPageDnaOptions): Promise<DnaCapture>
}

// ── Corpus ─────────────────────────────────────────────────────────────────────

/** A fixed-length numeric embedding of a DNA's aesthetic descriptor. */
export type AestheticVector = number[]

/** Where an exemplar came from. Open string so new sources need no code change. */
export type ExemplarSource =
  | 'variant'
  | 'mobbin'
  | 'awwwards'
  | 'rip'
  | 'manual'
  | (string & {})

/**
 * One world-class reference page in the corpus. The corpus is the data-driven
 * replacement for the scattered if/else domain tables: adding coverage is a new
 * Exemplar row, not a new code branch.
 */
export interface Exemplar {
  /** Stable id (slug of source+url). */
  id: string
  source: ExemplarSource
  url: string
  /** Page archetype — the hard retrieval filter. */
  pageType: PageType
  /** Job-to-be-done this page serves (e.g. "convert a visitor to signup"). */
  jobToBeDone: string
  dna: DesignDNA
  /** On-disk screenshot path (per the rip.ts manifest layout). */
  screenshotPath: string
  /** Precomputed aesthetic embedding for retrieval. */
  aestheticVector: AestheticVector
  /**
   * Elo/Bradley-Terry taste rating, seeded at corpus-build time and updated by
   * pairwise human/judge votes. Used as a retrieval tie-break and a taste prior.
   */
  eloRating: number
}

/**
 * A retrieval query. The aesthetic embedding is computed ONCE by the
 * orchestrator and passed in here — the matcher is pure and never recomputes an
 * embedding, eliminating the "two sources of the same vector" drift.
 */
export interface CorpusQuery {
  /** Hard filter: only same-type exemplars are candidates. */
  pageType: PageType
  /** Soft signal: token-overlap against Exemplar.jobToBeDone (low default weight). */
  jobToBeDone: string
  /** Authoritative aesthetic embedding of the page-under-audit's DNA. */
  aestheticVector: AestheticVector
  /** Optional deterministic structural feature vector for a secondary signal. */
  structuralVector?: number[]
}

/**
 * Relative blend weights for the matcher's score. Aesthetic + pageType dominate;
 * the free-form job signal is intentionally low because classification.intent is
 * noisy and is fabricated on `--profile` runs.
 */
export interface RetrieveWeights {
  aesthetic: number
  structural: number
  job: number
}

/**
 * One ranked retrieval hit.
 */
export interface RetrievalResult {
  exemplar: Exemplar
  /** Blended similarity score, 0-1 (higher = closer). */
  score: number
  /** Human-readable reasons the exemplar matched (for the artifact/provenance). */
  reasons: string[]
}

/**
 * Pure k-nearest retrieval boundary. THE de-hardcoding core: a novel page type
 * still resolves to its nearest aesthetic/job neighbour instead of falling
 * through an if/else table. Implemented by a pure function — no IO, no LLM.
 */
export interface ExemplarMatcher {
  retrieve(
    query: CorpusQuery,
    corpus: Exemplar[],
    weights?: RetrieveWeights,
  ): RetrievalResult[]
}

/**
 * READ side of the corpus disk boundary. This is ALL the runtime audit path
 * (engine/core, retrieval/matcher) ever needs — load the corpus once, resolve a
 * screenshot path, look one row up. Fails closed (missing dir → empty corpus /
 * null get), never fabricates an exemplar. The core depends on this narrow read
 * interface so it cannot reach the authoring mutators it never invokes.
 */
export interface CorpusReader {
  /** Load all exemplars from the manifest. */
  load(): Promise<Exemplar[]>
  /** Look up one exemplar by id, or null if absent. */
  get(id: string): Promise<Exemplar | null>
  /** Resolve an exemplar's screenshot to an absolute path. */
  resolveScreenshot(exemplar: Exemplar): string
}

/**
 * WRITE side of the corpus disk boundary. Used ONLY by the offline authoring
 * path (corpus/build) — never by the audit hot path. Kept separate from
 * CorpusReader so a runtime module that holds a reader cannot mutate the corpus.
 */
export interface CorpusWriter {
  /** Insert or replace an exemplar (corpus authoring). */
  upsert(exemplar: Exemplar): Promise<void>
  /** Persist a screenshot for an exemplar; returns its on-disk path. */
  saveScreenshot(id: string, png: Buffer): Promise<string>
}

/**
 * The full disk boundary for the exemplar corpus (JSONL records + sidecar
 * screenshots). The ONLY module that touches the corpus directory. Concrete
 * `createFileCorpusStore` implements both halves; corpus/build consumes the full
 * surface, while engine/core/matcher accept only `CorpusReader`.
 */
export interface CorpusStore extends CorpusReader, CorpusWriter {}

// ── Embedding ──────────────────────────────────────────────────────────────────

/**
 * The aesthetic-embedding boundary. The deterministic hash implementation is the
 * offline/test default (so retrieval works with zero provider and unit tests
 * never hit the network); a real provider is swapped in when an API key exists.
 */
export interface EmbeddingProvider {
  /** Stable id of the backing model ('hash-v1', 'openai:text-embedding-3-small', …). */
  readonly id: string
  /** Embed N descriptor strings → N fixed-length vectors. */
  embed(texts: string[]): Promise<AestheticVector[]>
}

// ── Reference context ──────────────────────────────────────────────────────────

/** How an operator-supplied `--reference` was interpreted. */
export type ReferenceKind = 'url' | 'rip' | 'tokens' | 'exemplar'

/**
 * A reference resolved ONCE before the page/rep loops and reused for every page
 * and repetition, so reference-grounded runs stay within the ±0.5 reproducibility
 * gate. When set, this single target stands in for (or augments) corpus
 * retrieval.
 */
export interface ReferenceContext {
  kind: ReferenceKind
  dna: DesignDNA
  /** Optional screenshot for a future vision judge. */
  screenshotPath?: string
  /** Budget-bounded prompt-ready summary of the reference DNA. */
  summary: string
}

// ── Generation ─────────────────────────────────────────────────────────────────

/**
 * Everything the generator needs about the page-under-audit (not the exemplars,
 * which are passed alongside as RetrievalResult[]).
 */
export interface GenerationContext {
  url: string
  classification: PageClassification
  dna: DesignDNA
  measurements?: MeasurementBundle
  /** Optional composed-rubric body injected as scoring criteria. */
  rubricBody?: string
}

/** A proposed type system for a redesign direction. */
export interface TypeSystemSpec {
  families: string[]
  /** Target scale in px. */
  scalePx: number[]
  /** Target modular ratio. */
  ratio: number
  rationale: string
}

/** A proposed color system for a redesign direction. */
export interface ColorSystemSpec {
  primary: string
  accent?: string
  neutrals: string[]
  background: string
  rationale: string
}

/** A proposed motion spec for a redesign direction. */
export interface MotionSpec {
  durationsMs: number[]
  easings: string[]
  /** Where motion is applied and why (e.g. "stagger hero cards on enter"). */
  cues: string[]
}

/** A single revised copy element. */
export interface CopyRevision {
  /** CSS selector or semantic location of the copy. */
  location: string
  before?: string
  after: string
}

/**
 * A NAMED redesign direction — the core generative artifact. Grounded in
 * concrete world-class exemplars by id so the judge can give reference-specific
 * feedback and the loop compresses to 1-2 shots.
 */
export interface RedesignDirection {
  id: string
  /** Evocative name (e.g. "Editorial Calm", "Dense Control Room"). */
  name: string
  /** Why this direction fits the page's job-to-be-done. */
  rationale: string
  /** ASCII / box-drawing layout diagram of the proposed structure. */
  asciiLayout: string
  typeSystem: TypeSystemSpec
  colorSystem: ColorSystemSpec
  motionSpec: MotionSpec
  /** Ordered information hierarchy, most prominent first. */
  hierarchy: string[]
  /** Revised copy for key surfaces. */
  copy: CopyRevision[]
  /** Exemplar ids this direction is grounded in (⊆ retrieved ids). */
  groundedInExemplarIds: string[]
}

/** A typed parse failure — never a fabricated direction. */
export interface DirectionParseError {
  ok: false
  reason: string
}

/** Result of parsing one model response into a direction. */
export type DirectionParseResult =
  | { ok: true; direction: RedesignDirection }
  | DirectionParseError

/**
 * LLM boundary: turn page context + retrieved exemplars into 2-3 grounded
 * directions. The shipped adapter fans out one cheap `brain.complete` call per
 * exemplar concurrently; tests inject a fake returning canned JSON.
 */
export interface RedesignGenerator {
  generate(
    ctx: GenerationContext,
    exemplars: RetrievalResult[],
    opts?: { count?: number; onDirection?: (d: RedesignDirection) => void },
  ): Promise<RedesignDirection[]>
}

// ── Judging & ranking ──────────────────────────────────────────────────────────

/**
 * One side of a comparison. Carries the summaries the judge reasons over and an
 * optional screenshot path (used only by a future vision judge — the default
 * text judge ignores it).
 */
export interface JudgeSubject {
  id: string
  /** Budget-bounded DNA summary. */
  dnaSummary: string
  /** Direction summary, when comparing generated directions. */
  directionSummary?: string
  screenshotPath?: string
}

/**
 * Input to a single judge comparison in a single slot order. The pure debias
 * core calls the judge twice (A/B then B/A) and reconciles.
 */
export interface JudgePairInput {
  a: JudgeSubject
  b: JudgeSubject
  /** The named reference both sides are judged against. */
  reference?: ReferenceContext
  rubricBody?: string
  /**
   * Scopes this comparison to ONE product-quality dimension. Set only by the
   * absolute quality leg, which issues one dimension-scoped comparison per
   * `Dimension` so `QualityAssessment.dimensionWinRates` is judged per-dimension
   * (never one overall number stamped across dims). Absent ⇒ holistic comparison
   * (the relative direction-ranking leg). The judge prompt narrows its rubric to
   * this dimension when present.
   */
  dimension?: Dimension
}

/**
 * The raw, slot-relative verdict from ONE judge call (before debiasing). `A`/`B`
 * refer to presentation slots, not stable ids — reconciliation maps them back.
 */
export interface RawVerdict {
  winnerSlot: 'A' | 'B' | 'tie'
  /** Judge confidence 0-1. */
  confidence: number
  /** Reference-specific reasons. */
  reasons: string[]
  /**
   * Echoes `JudgePairInput.dimension` when the comparison was dimension-scoped,
   * so the quality leg can bucket each verdict into the right per-dimension
   * win-rate. Absent on holistic (direction-ranking) comparisons.
   */
  dimension?: Dimension
  tokensUsed?: number
}

/**
 * A position-debiased pairwise verdict keyed by stable direction ids. Produced
 * by reconciling the two slot orders; disagreement collapses to a tie so the
 * verdict measures taste, not slot bias.
 */
export interface TasteVerdict {
  aId: string
  bId: string
  /** Stable winner id, or 'tie'. */
  winner: string | 'tie'
  /** Strength of preference 0-1 (averaged across the two orders). */
  margin: number
  reasons: string[]
}

/**
 * The Bradley-Terry / Elo rollup of many pairwise verdicts into a single ranking.
 */
export interface RankResult {
  /** Direction ids best→worst. */
  order: string[]
  /** The winning direction id. */
  winnerId: string
  /** Bradley-Terry strengths per id (sum-normalised). */
  bradleyTerry: Record<string, number>
  /** Elo ratings per id. */
  elo: Record<string, number>
}

/**
 * Pure rollup boundary. Implemented by a pure function (no LLM, no IO); modelled
 * as an interface only so callers depend on the contract, not the solver.
 */
export interface DirectionRanker {
  rank(ids: string[], verdicts: TasteVerdict[]): RankResult
}

/**
 * The single LLM/vision comparison boundary. NARROW by design: one comparison,
 * one slot order, returns a RawVerdict. All debiasing/aggregation lives in pure
 * cores around it. The shipped default is text-only over `brain.complete`; a
 * vision judge is a future drop-in implementing the same interface (it must NOT
 * be faked by overloading `brain.auditDesign`).
 */
export interface TasteJudge {
  readonly id: string
  compare(input: JudgePairInput): Promise<RawVerdict>
}

/** A recorded human pairwise preference, for judge calibration. */
export interface HumanVote {
  aId: string
  bId: string
  winner: string | 'tie'
}

/** Judge-vs-human agreement over a vote set. */
export interface CalibrationResult {
  /** Fraction of comparisons where judge and human agree, 0-1 (ties excluded). */
  agreement: number
  /** Number of comparisons scored. */
  n: number
}

// ── Headline scoring (absolute quality) ────────────────────────────────────────

/**
 * The ABSOLUTE quality assessment of the page-under-audit, produced by judging
 * the current page against the retrieved world-class exemplars (position-swapped
 * pairwise → win-rate). This — NOT the relative direction ranking — is the
 * single, honest scoring authority: it feeds the 0-10 headline score, the
 * per-`Dimension` `precomputedScores` (skipping stage-8's LLM call), and the
 * overall-derived 8-dim DesignSystemScore.
 */
export interface QualityAssessment {
  /** Win-rate of the current page vs exemplars, 0-1 (0.5 ≈ on par). */
  overallWinRate: number
  /**
   * Per-product-dimension win-rates, keyed by the 5-dim `Dimension` taxonomy.
   * Each entry is the win-rate of a dimension-scoped comparison set (the quality
   * leg issues one `JudgePairInput.dimension` per `Dimension`). Present ⇒ the
   * dims are genuinely judge-resolved; `score-core.toDimensionScores` maps them
   * into the rich `Record<Dimension, DimensionScore>` that stage 8 consumes.
   * Omitted ⇒ no per-dim signal was gathered (single-leg budget); callers must
   * NOT fabricate per-dim scores from `overallWinRate`.
   */
  dimensionWinRates?: Partial<Record<Dimension, number>>
  /** How many pairwise comparisons backed this assessment. */
  comparisons: number
}

// ── Artifact & engine output ───────────────────────────────────────────────────

/**
 * The rich, first-class output of the engine. This is NOT a throwaway side file:
 * it is returned by the library entry (`runReferenceRedesign`) and written to
 * disk, and is the artifact the taste eval consumes.
 */
export interface RedesignArtifact {
  url: string
  /** Directions ordered by ranking (winner first). */
  directions: RedesignDirection[]
  ranking: RankResult
  /** Provenance: which exemplars grounded the generation. */
  retrieval: RetrievalResult[]
  verdicts: TasteVerdict[]
  /** Id of the operator-supplied reference, when one was used. */
  referenceId?: string
  tokensUsed: number
}

/**
 * The full result of one engine run, shared by BOTH entrypoints. The pure core
 * returns this; `run.ts` surfaces `.artifact`, `pipeline/evaluate-reference.ts`
 * maps it onto a PageAuditResult. Single core, two return-shapings — no
 * duplicated orchestration.
 */
export interface RedesignRunResult {
  artifact: RedesignArtifact
  /** Absolute quality assessment of the current page. */
  quality: QualityAssessment
  /** Derived 0-10 headline score. */
  headlineScore: number
  /**
   * The stage-8 `precomputedScores` hook: the 5-dim product-quality scores in the
   * exact `Record<Dimension, DimensionScore>` shape `buildAuditResult` consumes,
   * so passing this skips its second multidim LLM call. Built by
   * `score-core.toDimensionScores` from `quality.dimensionWinRates` (each dim's
   * win-rate → score, with range/confidence reflecting comparison count).
   */
  dimensionScores: Record<Dimension, DimensionScore>
  /**
   * The flat 8-dim design-system score for `PageAuditResult.designSystemScore`
   * (back-compat surface). HONESTLY a coarse projection of `overallWinRate` —
   * the judge resolves the 5 product `Dimension`s, not these 8 design-system
   * axes — so it is NOT a second per-dimension scoring authority.
   */
  designSystemScore: DesignSystemScore
  /** Findings projected from the winner + measurement ground truth. */
  findings: DesignFinding[]
  classification: PageClassification
  measurements: MeasurementBundle
  tokensUsed: number
}

// ── Flag, config & budget ──────────────────────────────────────────────────────

/** Pipeline evaluation mode. Absent/`'v1'` ⇒ byte-identical legacy behaviour. */
export type EvalMode = 'v1' | 'reference-grounded'

/**
 * Cost ceiling for one engine run. Pairwise judging multiplies LLM calls, so
 * every leg is explicitly capped and the orchestrator runs independent calls
 * concurrently up to `concurrency`.
 */
export interface EngineBudget {
  /** Max generation calls (≈ direction count). */
  maxGenerationCalls: number
  /** Max judge calls across quality + direction legs. */
  maxJudgeCalls: number
  /** Repetitions per pairwise comparison (each rep = both slot orders). */
  judgeReps: number
  /** Max concurrent in-flight LLM calls. */
  concurrency: number
  /**
   * When true, screen directions at 1 rep then validate only the top-2 at full
   * reps (the two-stage screen/validate pattern) to contain cost.
   */
  screenThenValidate: boolean
}

/**
 * Resolved configuration for the reference-grounded engine. Lives on
 * AuditOnePageOptions as a sibling of `overrides` — NOT inside AuditOverrides
 * (a static prompt-knob bag) and NOT on DriverConfig (which the audit path
 * bypasses).
 */
export interface ReferenceGroundedConfig {
  /** Directory of the exemplar corpus. */
  corpusDir: string
  /** Where the rich artifact is written. */
  artifactDir?: string
  /** Number of exemplars to retrieve. */
  k: number
  /** Number of redesign directions to generate (2-3). */
  directionCount: number
  /** Judge backend. 'vision' is reserved for a future clean Brain seam. */
  judge: 'text' | 'vision'
  /** Embedding backend; falls back to 'deterministic' when no key is present. */
  embedder: 'deterministic' | 'provider'
  budget: EngineBudget
  /** Operator-supplied reference, resolved once. */
  reference?: ReferenceContext
  /** Model id override for generation/judging. */
  model?: string
}

/**
 * The injected dependency bundle for the shared core. The core depends ONLY on
 * these narrow interfaces; concrete adapters are wired at the composition roots
 * (`run.ts`, `pipeline/evaluate-reference.ts`) and passed in — so the core never
 * imports a concrete IO/LLM module and stays a pure sequencer.
 */
export interface ReferenceEngineDeps {
  extractor: DesignDnaExtractor
  /**
   * READ-ONLY corpus access. The core never authors the corpus, so it depends on
   * `CorpusReader`, not the full `CorpusStore` — the authoring mutators
   * (upsert/saveScreenshot) are unreachable from the audit path by construction.
   */
  store: CorpusReader
  embedder: EmbeddingProvider
  matcher: ExemplarMatcher
  generator: RedesignGenerator
  judge: TasteJudge
  ranker: DirectionRanker
}

/**
 * Per-page input to the shared core. The exemplar `corpus` is loaded ONCE per
 * run by the L4 entrypoint (a single `deps.store.load()` before the page/rep
 * loops) and threaded in here — mirroring the acquire-once `ReferenceContext` —
 * so a multi-page / multi-rep run never re-reads, re-parses, and re-validates
 * the full corpus from disk. The core retrieves against this in-memory array and
 * does NOT call `store.load()` itself.
 */
export interface RedesignCoreInput {
  url: string
  classification: PageClassification
  measurements: MeasurementBundle
  screenshotPath?: string
  /** The full exemplar corpus, loaded once per run and reused across pages/reps. */
  corpus: Exemplar[]
  config: ReferenceGroundedConfig
}

// ── Taste eval bridge ──────────────────────────────────────────────────────────

/** A corpus-vs-corpus taste pair: a known-stronger vs known-weaker exemplar. */
export interface TastePair {
  strongId: string
  weakId: string
}

/** Corpus-order agreement over a set of taste pairs. */
export interface TasteAgreementResult {
  /** Fraction of pairs where the judge preferred the stronger member, 0-1. */
  agreementRate: number
  /** Number of non-tie comparisons. */
  n: number
}

/**
 * Bench metric shape for the taste eval. Mirrors the existing `patchMetrics`
 * branch pattern: an optional sibling field on a TrialResult that remaps the
 * ObjectiveVector axes (recall ← winsVsReference, precision ← corpusOrderAgreement)
 * with ZERO change to the 5-axis vector schema.
 */
export interface TasteMetrics {
  /** Generated-vs-reference wins. */
  winsVsReference: number
  /** Total comparisons backing winsVsReference. */
  comparisons: number
  /** Corpus-order agreement rate, when computed. */
  corpusOrderAgreement?: number
}
