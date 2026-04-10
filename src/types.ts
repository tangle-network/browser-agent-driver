/**
 * Core types for browser agent
 */

import type { SnapshotDiff } from './drivers/snapshot.js';

// ============================================================================
// Actions - What the agent can do
// ============================================================================

export interface ClickAction {
  action: 'click';
  selector: string;
}

export interface TypeAction {
  action: 'type';
  selector: string;
  text: string;
}

export interface ScrollAction {
  action: 'scroll';
  direction: 'up' | 'down';
  /** Scroll distance in pixels (default: 500) */
  amount?: number;
  /** Optional selector for scrolling a specific container (default: viewport) */
  selector?: string;
}

export interface NavigateAction {
  action: 'navigate';
  url: string;
}

export interface WaitAction {
  action: 'wait';
  ms: number;
}

export interface CompleteAction {
  action: 'complete';
  result: string;
}

export interface PressAction {
  action: 'press';
  selector: string;
  key: string;
}

export interface HoverAction {
  action: 'hover';
  selector: string;
}

export interface SelectAction {
  action: 'select';
  selector: string;
  value: string;
}

export interface EvaluateAction {
  action: 'evaluate';
  criteria: string;
}

export interface RunScriptAction {
  action: 'runScript';
  /** JavaScript expression to evaluate in page context */
  script: string;
}

/**
 * Gen 10 — Extract a numbered, text-rich index of elements matching a CSS
 * selector. Returns the visible textContent + tag + key attributes + a stable
 * selector for each match. The agent then picks elements by index in the next
 * turn (e.g., complete with `result: extracted[3].text`).
 *
 * This is the **capability change** Gen 10 ships: rather than asking the LLM
 * to guess a precise selector that returns one element, the agent gets a wide
 * net (e.g. `'p, span, dd, code'`) and reads the actual text content of every
 * match. Pick-by-content is dramatically more reliable than selector-by-name
 * on real-web pages where data lives in `<dl>/<dt>/<dd>/<code>/<pre>` or
 * inside obscurely-classed wrapper divs.
 *
 * Example payload for npm weekly downloads:
 *   {
 *     action: 'extractWithIndex',
 *     query: 'p, span, strong',
 *     contains: 'downloads',
 *   }
 *
 * Optional `contains` filters matches to only those containing the substring
 * (case-insensitive). Without `contains`, all matches are returned (capped at
 * 80 to keep the response readable).
 */
export interface ExtractWithIndexAction {
  action: 'extractWithIndex';
  /** CSS selector — broad selectors are fine, the response includes full text per match */
  query: string;
  /** Optional substring filter (case-insensitive) applied to textContent */
  contains?: string;
}

export interface VerifyPreviewAction {
  action: 'verifyPreview';
}

export interface AbortAction {
  action: 'abort';
  reason: string;
}

/**
 * Multi-field form fill — fill N fields, select N dropdowns, and check N
 * checkboxes in a SINGLE action. Replaces the click+type+click+type pattern
 * that takes one turn per field.
 *
 * Example payload for a 5-field form:
 *   {
 *     action: 'fill',
 *     fields: { '@t1': 'Jordan', '@t2': 'Rivera', '@t3': 'jordan@example.com' },
 *     selects: { '@s1': 'WA' },
 *     checks: ['@c1', '@c2'],
 *   }
 *
 * Each entry runs in order. Failures bail with the first error and report
 * which field failed so the agent can recover by switching to single-step
 * actions on the next turn.
 */
export interface BatchFillAction {
  action: 'fill';
  /** Map of @ref → text value to type into each field */
  fields?: Record<string, string>;
  /** Map of @ref → option value or label for select dropdowns */
  selects?: Record<string, string>;
  /** Array of @refs to check (checkboxes / radios) */
  checks?: string[];
}

/**
 * Sequential clicks on a known set of refs. For multi-step UI navigation
 * where the agent has identified the click chain ahead of time (e.g., open
 * menu → click submenu → click item).
 *
 * Each click runs in order with an optional interval. Failures bail with
 * the first error.
 */
export interface ClickSequenceAction {
  action: 'clickSequence';
  /** Array of @refs to click in order */
  refs: string[];
  /** Optional wait between clicks in ms (default: 100) */
  intervalMs?: number;
}

// Gen 13: Vision-first coordinate-based actions
export interface ClickAtAction {
  action: 'clickAt';
  /** X coordinate in virtual screen space (0-1024) */
  x: number;
  /** Y coordinate in virtual screen space (0-768) */
  y: number;
}

export interface TypeAtAction {
  action: 'typeAt';
  /** X coordinate in virtual screen space (0-1024) */
  x: number;
  /** Y coordinate in virtual screen space (0-768) */
  y: number;
  /** Text to type after clicking */
  text: string;
}

// Gen 23: SoM (Set-of-Marks) label-based action
export interface ClickLabelAction {
  action: 'clickLabel';
  /** Label number from the SoM overlay (e.g., 3 for element [3]) */
  label: number;
}

export interface TypeLabelAction {
  action: 'typeLabel';
  /** Label number from the SoM overlay */
  label: number;
  /** Text to type after clicking */
  text: string;
}

export type Action =
  | ClickAction
  | TypeAction
  | PressAction
  | HoverAction
  | SelectAction
  | ScrollAction
  | NavigateAction
  | WaitAction
  | EvaluateAction
  | RunScriptAction
  | ExtractWithIndexAction
  | VerifyPreviewAction
  | CompleteAction
  | AbortAction
  | BatchFillAction
  | ClickSequenceAction
  | ClickAtAction
  | TypeAtAction
  | ClickLabelAction
  | TypeLabelAction;

// ============================================================================
// Plan - Structured action sequence (Gen 7)
// ============================================================================

/**
 * A single step in a Plan. Wraps an action with a verification checkpoint
 * and optional recovery hint. The runner executes steps deterministically;
 * `expectedEffect` is the post-condition that must hold for the next step
 * to fire.
 */
export interface PlanStep {
  /**
   * The action to execute deterministically. Use Gen 6 batch verbs
   * (`fill`, `clickSequence`) wherever possible to minimize step count.
   */
  action: Action;
  /**
   * Post-condition the runner verifies before advancing. Same shape as
   * the existing `expectedEffect` on Turn — natural-language assertion
   * checked against the post-action snapshot.
   */
  expectedEffect: string;
  /**
   * Optional human-readable description of what this step does. Surfaced
   * in plan-step-executed events for observability and the live viewer.
   */
  rationale?: string;
}

/**
 * A complete plan from `Brain.plan()`. The runner attempts to execute
 * every step deterministically. On the first verification failure or
 * selector miss, the runner falls back to the existing per-action
 * decide loop with a `[REPLAN]` hint in extraContext.
 *
 * Plans are NOT trees — they're flat sequences. Branching is handled
 * by the per-action fallback loop, which decide()'s its way through
 * the unexpected state then potentially re-enters the planner.
 */
export interface Plan {
  /** Steps to execute in order */
  steps: PlanStep[];
  /**
   * Final result text the runner should emit as `complete` if all steps
   * pass verification. If absent, the runner emits a generic completion.
   */
  finalResult?: string;
  /**
   * Plan-level reasoning — what's the strategy, why this sequence?
   * Surfaced in plan-completed events for observability.
   */
  reasoning?: string;
}

// ============================================================================
// Page State - What the agent sees
// ============================================================================

export interface PageState {
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Simplified DOM snapshot (text format) */
  snapshot: string;
  /** Screenshot as base64 JPEG (optional, for debugging) */
  screenshot?: string;
  /** Diff from previous snapshot (undefined on first observe) */
  snapshotDiff?: string;
  /** Structured diff for programmatic use (undefined on first observe) */
  snapshotDiffRaw?: SnapshotDiff;
}

// ============================================================================
// Scenario - What the agent should accomplish
// ============================================================================

export interface Scenario {
  /** Natural language goal */
  goal: string;
  /** Starting URL (optional - uses current page if not set) */
  startUrl?: string;
  /** Explicit host allowlist for navigation/result selection (for benchmark and policy constraints) */
  allowedDomains?: string[];
  /** Max turns before giving up */
  maxTurns?: number;
  /** Abort signal for external cancellation (e.g., story timeout) */
  signal?: AbortSignal;
  /** Session ID for cross-run continuity. Runs with the same ID share session
   *  history regardless of domain. When omitted, sessions are scoped to domain. */
  sessionId?: string;
  /** Parent run ID — set when this run is a resume or fork of a previous run. */
  parentRunId?: string;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AgentConfig {
  /** LLM provider: 'openai' (default), 'anthropic', 'google', 'codex-cli', 'claude-code', or 'sandbox-backend' */
  provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  /** LLM model (default: gpt-5.4) */
  model?: string;
  /** Enable adaptive model routing for decide() (default: false) */
  adaptiveModelRouting?: boolean;
  /** Fast navigation model used when adaptive routing is enabled */
  navModel?: string;
  /** Provider for navModel (defaults to provider) */
  navProvider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  /** API key (defaults to OPENAI_API_KEY) */
  apiKey?: string;
  /** Custom API base URL (for LiteLLM, local models, etc.) */
  baseUrl?: string;
  /** Native sidecar backend type when using provider='sandbox-backend' */
  sandboxBackendType?: string;
  /** Optional sidecar backend profile/preset identifier */
  sandboxBackendProfile?: string;
  /** Optional native backend model provider (mainly for opencode) */
  sandboxBackendProvider?: string;
  /** Optional override for the default browser-agent system prompt */
  systemPrompt?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable vision/multimodal (screenshots sent to LLM). Default: true */
  vision?: boolean;
  /** Vision policy: always, never, or auto-escalate on ambiguous/stalled states */
  visionStrategy?: 'always' | 'never' | 'auto';
  /** Gen 13: observation mode — 'dom' (default), 'vision', or 'hybrid' */
  observationMode?: 'dom' | 'vision' | 'hybrid';
  /** Max conversation history turns to keep (default: 10) */
  maxHistoryTurns?: number;
  /** Number of retries on transient failures (default: 3) */
  retries?: number;
  /** Delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
  /** Minimum quality score (1-10) for auto-evaluate on complete. 0 = skip. */
  qualityThreshold?: number;
  /** Timeout per LLM request in ms (default: 60000) */
  llmTimeoutMs?: number;
  /** Use a lower-token prompt/snapshot strategy on the first turn */
  compactFirstTurn?: boolean;
  /** Verify goal completion before accepting 'complete' action (default: true) */
  goalVerification?: boolean;
  /** Enable trajectory scoring when selecting reference traces (default: false) */
  traceScoring?: boolean;
  /** Retention window for trajectory scoring in days (default: 30) */
  traceTtlDays?: number;
  /** Optional micro-planning: execute small follow-up actions within a turn */
  microPlan?: MicroPlanConfig;
  /**
   * Gen 7 plan-then-execute. When true, BrowserAgent.run() makes a single
   * `Brain.plan()` LLM call up front, then executes the plan steps
   * deterministically without re-entering the LLM until verification fails.
   * On the first plan deviation, the runner falls back to the existing
   * per-action observe→decide→execute loop with a [REPLAN] hint injected.
   *
   * Default: false (per-action loop only). Set to true to enable the planner.
   * Disable via BAD_PLANNER=0 env override.
   */
  plannerEnabled?: boolean;
  /**
   * Gen 8: extra wait BEFORE the planner's initial observe, in ms. Used by
   * real-web runs (planner-on-realweb.mjs) to give SPAs time to load their
   * dynamic content before the planner snapshots the page. Without this,
   * the planner sees a half-loaded SPA and emits runScript queries against
   * selectors that don't exist yet, returning null/empty. Default: 0.
   */
  initialObserveSettleMs?: number;
  /** Optional scout that ranks ambiguous link choices before the actor decides */
  scout?: ScoutConfig;
  /** Optional supervisor that can intervene when the run is hard-stalled */
  supervisor?: SupervisorConfig;
  /** Runtime observability artifacts (console/network/trace) */
  observability?: ObservabilityConfig;
  /** Enable DeFi/crypto app awareness in the brain (auto-set when wallet mode is active) */
  walletMode?: boolean;
  /** Wallet address (hex, with 0x prefix) — used for RPC interception calldata matching */
  walletAddress?: string;
  /** CAPTCHA solving using LLM vision (screenshot + model identifies tiles to click) */
  captcha?: {
    enabled?: boolean;
    /** Max solve attempts per encounter (default: 5) */
    maxAttempts?: number;
  };
}

export interface ObservabilityConfig {
  /** Enable runtime observability artifacts (default: true) */
  enabled?: boolean;
  /** Capture browser console warnings/errors and page errors (default: true) */
  captureConsole?: boolean;
  /** Capture failed requests and HTTP 4xx/5xx responses (default: true) */
  captureNetwork?: boolean;
  /** Trace capture policy (default: 'on-failure') */
  tracePolicy?: 'off' | 'on-failure' | 'always';
  /** Max console/page error entries persisted per test (default: 200) */
  maxConsoleEntries?: number;
  /** Max network entries persisted per test (default: 200) */
  maxNetworkEntries?: number;
}

export interface MicroPlanConfig {
  /** Enable multi-action micro plans (default: false) */
  enabled?: boolean;
  /** Max actions to execute in one turn including primary action (default: 2) */
  maxActionsPerTurn?: number;
}

export interface ScoutConfig {
  /** Enable scout recommendations on ambiguous link/result pages */
  enabled?: boolean;
  /** Optional model override for scout reasoning */
  model?: string;
  /** Optional provider override for scout model */
  provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  /** Allow the scout to inspect the current screenshot when available */
  useVision?: boolean;
  /** Max ranked candidates sent to the scout */
  maxCandidates?: number;
  /** Skip scout when the top deterministic score is already above this threshold */
  minTopScore?: number;
  /** Skip scout when the top-vs-second score gap is wider than this threshold */
  maxScoreGap?: number;
  /** Enable a top-2 read-only challenger on ambiguous visible-link pages */
  readOnlyTop2Challenger?: boolean;
}

export interface SupervisorConfig {
  /** Enable supervisor interventions (default: true in config defaults) */
  enabled?: boolean;
  /** Optional model override for supervisor reasoning */
  model?: string;
  /** Optional provider override for supervisor model */
  provider?: 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend';
  /** Allow the supervisor to inspect the current screenshot when available */
  useVision?: boolean;
  /** Minimum completed turns before supervisor can intervene */
  minTurnsBeforeInvoke?: number;
  /** Cooldown turns between supervisor interventions */
  cooldownTurns?: number;
  /** Hard cap on interventions per run */
  maxInterventions?: number;
  /** Number of recent turns used to determine hard-stall conditions */
  hardStallWindow?: number;
}

export interface SupervisorSignal {
  severity: 'none' | 'soft' | 'hard';
  reasons: string[];
  repeatedActionCount: number;
  unchangedTurns: number;
  errorTurns: number;
  verificationFailures: number;
}

export interface SupervisorDirective {
  decision: 'none' | 'inject_feedback' | 'force_action' | 'abort';
  feedback?: string;
  action?: Action;
  reason?: string;
  confidence?: number;
  raw?: string;
}

// ============================================================================
// Turn - One observe → decide → execute cycle
// ============================================================================

export interface Turn {
  turn: number;
  state: PageState;
  action: Action;
  /** Raw LLM response text */
  rawLLMResponse?: string;
  /** LLM's reasoning/thinking (if provided) */
  reasoning?: string;
  /** Multi-step plan from brain */
  plan?: string[];
  /** Actual action sequence executed this turn (primary action first) */
  executedActions?: Action[];
  /** Current step in the plan */
  currentStep?: number;
  /** Expected effect of the action (for verification) */
  expectedEffect?: string;
  /** Whether the expected effect was verified */
  verified?: boolean;
  /** Verification failure message */
  verificationFailure?: string;
  /** Tokens used for this turn */
  tokensUsed?: number;
  /** Input (prompt) tokens for this turn */
  inputTokens?: number;
  /** Output (completion) tokens for this turn */
  outputTokens?: number;
  /**
   * Prompt-cache hit tokens (provider-agnostic). Populated by OpenAI/ZAI/GLM
   * automatic server-side caching and by Anthropic explicit cache_control.
   */
  cacheReadInputTokens?: number;
  /** Prompt-cache write tokens (cache miss, first turn) */
  cacheCreationInputTokens?: number;
  /** Which model handled this turn (for adaptive routing cost tracking) */
  modelUsed?: string;
  /** Time taken for this turn in ms */
  durationMs: number;
  /** Error message if turn failed */
  error?: string;
  /** Bounding box of the target element at action time (for replay overlays) */
  actionBounds?: { x: number; y: number; width: number; height: number };
}

// ============================================================================
// Result
// ============================================================================

export interface AgentResult {
  success: boolean;
  result?: string;
  reason?: string;
  turns: Turn[];
  totalMs: number;
  /** Phase timing instrumentation for the run */
  phaseTimings?: RunPhaseTimings;
  /** Startup-path instrumentation for the run */
  startupDiagnostics?: RunStartupDiagnostics;
  /** Wasted-turn instrumentation for the run */
  wasteMetrics?: RunWasteMetrics;
  /** Quality evaluation (if qualityThreshold is set or agent used "evaluate" action) */
  evaluation?: {
    score: number;
    assessment: string;
    strengths: string[];
    issues: string[];
    suggestions: string[];
  };
  /** Goal achievement verification (if goalVerification is enabled) */
  goalVerification?: GoalVerification;
}

export interface GoalVerification {
  /** Did the LLM judge the goal as achieved? */
  achieved: boolean;
  /** Confidence 0-1 */
  confidence: number;
  /** Evidence supporting achievement */
  evidence: string[];
  /** Missing criteria (empty if achieved) */
  missing: string[];
}

// ============================================================================
// Test Runner Types
// ============================================================================

export interface SuccessCriterion {
  type: 'url-contains' | 'url-matches' | 'element-visible' | 'element-text' | 'element-count' | 'custom';
  /** CSS/Playwright selector for element-based criteria */
  selector?: string;
  /** Expected value (URL substring, text content, element count) */
  value?: string;
  /** Custom check function (receives Playwright page) */
  check?: (page: import('playwright').Page) => Promise<boolean>;
  /** Human-readable description of what this checks */
  description?: string;
}

export interface TestCase {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Detailed description */
  description?: string;
  /** Category for grouping */
  category?: string;
  /** Tags for filtering */
  tags?: string[];

  // Execution
  /** Starting URL */
  startUrl: string;
  /** Natural language goal for the agent */
  goal: string;
  /** Explicit host allowlist for navigation/result selection */
  allowedDomains?: string[];
  /** Max turns allowed (default: 30) */
  maxTurns?: number;
  /** Timeout in ms */
  timeoutMs?: number;

  // Orchestration
  /** Priority (lower = runs first) */
  priority?: number;
  /** IDs of prerequisite test cases that must pass first */
  dependsOn?: string[];

  // Session continuity
  /** Session ID for cross-run continuity. Runs with the same ID share session
   *  history regardless of domain. When omitted, sessions are scoped to domain. */
  sessionId?: string;
  /** Parent run ID — set when this run is a resume or fork of a previous run. */
  parentRunId?: string;

  // Lifecycle hooks
  /** Run before the agent starts (e.g., seed data, reset state) */
  setup?: (page: import('playwright').Page) => Promise<void>;
  /** Run after the agent finishes (e.g., cleanup) */
  teardown?: (page: import('playwright').Page) => Promise<void>;

  // Verification
  /** Ground-truth criteria verified AFTER the agent completes */
  successCriteria?: SuccessCriterion[];
  /** Natural-language criteria appended to the goal for LLM awareness */
  successDescription?: string;
}

export interface CriterionResult {
  criterion: SuccessCriterion;
  passed: boolean;
  detail?: string;
}

export interface TestResult {
  testCase: TestCase;
  agentResult: AgentResult;
  /** Agent's self-reported success */
  agentSuccess: boolean;
  /** Ground-truth verification (true if no criteria defined OR all pass) */
  verified: boolean;
  /** Per-criterion verification results */
  criteriaResults?: CriterionResult[];
  /** Human-readable pass/fail explanation */
  verdict: string;
  /** Number of turns used */
  turnsUsed: number;
  /** Total tokens consumed */
  tokensUsed: number;
  /** Total input (prompt) tokens */
  inputTokens?: number;
  /** Total output (completion) tokens */
  outputTokens?: number;
  /** Estimated cost in USD (based on model pricing) */
  estimatedCostUsd?: number;
  /** Duration in ms */
  durationMs: number;
  /** Phase timing instrumentation copied from agentResult for report consumers */
  phaseTimings?: RunPhaseTimings;
  /** Startup-path instrumentation copied from agentResult for report consumers */
  startupDiagnostics?: RunStartupDiagnostics;
  /** Wasted-turn instrumentation copied from agentResult for report consumers */
  wasteMetrics?: RunWasteMetrics;
  startedAt: Date;
  endedAt: Date;
  /** Screenshots captured during execution */
  screenshots?: { turn: number; base64: string }[];
  /** Whether this test was skipped (unmet dependencies) */
  skipped?: boolean;
  skipReason?: string;
  /** Runtime/backend configuration that produced this result */
  runtime?: RunRuntimeConfig;
}

export interface TestSuiteResult {
  /** Model used */
  model: string;
  /** Runtime/backend configuration for the suite */
  runtime?: RunRuntimeConfig;
  /** Run timestamp */
  timestamp: string;
  /** Per-test results */
  results: TestResult[];
  /** Aggregate metrics */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    avgTurns: number;
    avgTokens: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    totalDurationMs: number;
  };
}

export interface RunRuntimeConfig {
  provider: NonNullable<AgentConfig['provider']>;
  model: string;
  sandboxBackendType?: string;
  sandboxBackendProfile?: string;
  sandboxBackendProvider?: string;
}

export interface RunPhaseTimings {
  initialNavigateMs?: number;
  firstObserveMs?: number;
  firstDecideMs?: number;
  firstExecuteMs?: number;
}

export interface RunStartupDiagnostics {
  firstTurnSeen: boolean;
  timeToFirstTurnMs?: number;
  zeroTurnFailureClass?: 'pre_first_turn_timeout' | 'provider_or_credentials' | 'runner_startup_error' | 'unknown';
  startupReason?: string;
}

export interface RunWasteMetrics {
  repeatedQueryCount: number;
  verificationRejectionCount: number;
  turnsAfterSufficientEvidence: number;
  errorTurns: number;
}

// ============================================================================
// Trajectory Memory Types
// ============================================================================

export interface TrajectoryStep {
  /** URL at this step */
  url: string;
  /** Action taken */
  action: Action;
  /** Hash of snapshot for similarity comparison */
  snapshotHash: string;
  /** Whether the expected effect was verified */
  verified?: boolean;
}

export interface Trajectory {
  /** Unique ID */
  id: string;
  /** Goal that was achieved */
  goal: string;
  /** Normalized origin for environment scoping (e.g. https://app.example.com) */
  origin?: string;
  /** Steps taken */
  steps: TrajectoryStep[];
  /** Whether this trajectory succeeded */
  success: boolean;
  /** Total duration */
  durationMs: number;
  /** Model used */
  model: string;
  /** When this was recorded */
  timestamp: string;
}

// ============================================================================
// Design Audit Types
// ============================================================================

export interface DesignFinding {
  category: 'visual-bug' | 'layout' | 'contrast' | 'alignment' | 'spacing' | 'typography' | 'accessibility' | 'ux';
  severity: 'critical' | 'major' | 'minor';
  description: string;
  location: string;
  suggestion: string;
  /** CSS selector targeting the element to fix */
  cssSelector?: string;
  /** Concrete CSS property:value fix */
  cssFix?: string;
  // ── Gen 3 ROI fields ────────────────────────────────────────────────
  /** 1-10: how much this hurts the user experience */
  impact?: number;
  /** 1-10: how hard the fix is (1 = trivial CSS change, 10 = architectural rework) */
  effort?: number;
  /** Scope of the fix's effect — page-specific, section-specific, component-level, or design-system-wide */
  blast?: 'page' | 'section' | 'component' | 'system';
  /** Computed: (impact * blastWeight) / effort. Higher = fix this first. */
  roi?: number;
  /** Number of audited pages where this finding (or its dedupe-equivalent) appears */
  pageCount?: number;
}

export interface DesignSystemScore {
  layout: number;
  typography: number;
  color: number;
  spacing: number;
  components: number;
  interactions: number;
  accessibility: number;
  polish: number;
}

export interface DesignEvolveResult {
  /** Initial audit score */
  beforeScore: number;
  /** Score after applying fixes */
  afterScore: number;
  /** Score delta (positive = improvement) */
  delta: number;
  /** Rounds of fix-reaudit cycles completed */
  rounds: number;
  /** Fixes that were applied */
  appliedFixes: Array<{ cssSelector: string; cssFix: string; finding: string }>;
  /** Fixes that were generated but not applied */
  skippedFixes: Array<{ cssSelector: string; cssFix: string; reason: string }>;
  /** Per-round scores for convergence tracking */
  scoreHistory: number[];
  /** Generated CSS override stylesheet */
  cssOverride: string;
}

export interface FlowAuditResult {
  flow: string;
  steps: number;
  reachedGoal: boolean;
  findings: DesignFinding[];
  screenshots: string[];
  score: number;
  error?: string;
}

export interface DesignAuditReport {
  timestamp: string;
  flows: FlowAuditResult[];
  summary: {
    healthScore: number;
    totalFindings: number;
    critical: number;
    major: number;
    minor: number;
  };
}

export interface AuditFlow {
  name: string;
  startUrl: string;
  goal: string;
  checkpoints: string[];
  maxTurns?: number;
}

// ============================================================================
// Design Token Extraction Types
// ============================================================================

export interface DesignTokens {
  url: string
  extractedAt: string
  viewportsAudited: string[]
  customProperties: Record<string, string>
  colors: ColorToken[]
  typography: {
    families: FontFamily[]
    scale: TypeScaleEntry[]
  }
  brand: {
    title?: string
    description?: string
    themeColor?: string
    favicon?: string
    ogImage?: string
    appleTouchIcon?: string
    manifestUrl?: string
  }
  logos: LogoAsset[]
  icons: SvgIcon[]
  fontFiles: FontFile[]
  images: ImageAsset[]
  videos: VideoAsset[]
  stylesheets: Array<{ url: string; localPath?: string }>
  responsive: Record<string, ViewportTokens>
  detectedLibraries: string[]
}

export interface VideoAsset {
  url: string
  type: 'video' | 'video-source'
  poster?: string
  localPath?: string
  mimeType?: string
  sizeBytes?: number
}

export interface ColorToken {
  value: string
  hex: string
  count: number
  properties: string[]
  cluster?: 'primary' | 'secondary' | 'accent' | 'neutral' | 'background' | 'border'
}

export interface FontFamily {
  family: string
  weights: number[]
  classification: 'heading' | 'body' | 'mono' | 'display'
}

export interface TypeScaleEntry {
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  fontFamily: string
  usage: 'heading' | 'body' | 'caption' | 'label'
  tag?: string
  count: number
}

export interface LogoAsset {
  type: 'svg' | 'img'
  src?: string
  alt?: string
  width?: number
  height?: number
  svgContent?: string
}

export interface SvgIcon {
  selector: string
  viewBox?: string
  width?: number
  height?: number
  content: string
}

export interface ViewportTokens {
  width: number
  height: number
  spacing: SpacingToken[]
  gridBaseUnit?: number
  borders: BorderToken[]
  shadows: ShadowToken[]
  components: {
    buttons: ComponentFingerprint[]
    inputs: ComponentFingerprint[]
    cards: ComponentFingerprint[]
    nav: NavPattern[]
  }
  animations: AnimationToken[]
  screenshotPath?: string
}

export interface SpacingToken {
  value: string
  count: number
  properties: string[]
}

export interface BorderToken {
  borderRadius: string
  count: number
}

export interface ShadowToken {
  value: string
  count: number
}

export interface ComponentFingerprint {
  fingerprint: string
  count: number
  exampleText?: string
  styles: Record<string, string>
}

export interface NavPattern {
  selector: string
  layout: Record<string, string>
  linkCount: number
  linkStyles: Record<string, string>
}

export interface AnimationToken {
  property: string
  value: string
  count: number
}

export interface FontFile {
  family: string
  weight: string
  style: string
  src: string
  format: string
  localPath?: string
}

export interface ImageAsset {
  url: string
  type: 'img' | 'background' | 'favicon' | 'og-image' | 'icon' | 'video-poster' | 'lazy-load'
  localPath?: string
  mimeType?: string
  sizeBytes?: number
}

// ============================================================================
// Preview Verification Types
// ============================================================================

export interface PreviewVerification {
  previewUrl: string;
  appLoaded: boolean;
  title: string;
  snapshot: string;
  screenshot?: string;
  errors: string[];
}
