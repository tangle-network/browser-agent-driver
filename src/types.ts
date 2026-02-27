/**
 * Core types for browser agent
 */

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

export interface VerifyPreviewAction {
  action: 'verifyPreview';
}

export interface AbortAction {
  action: 'abort';
  reason: string;
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
  | VerifyPreviewAction
  | CompleteAction
  | AbortAction;

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
}

// ============================================================================
// Scenario - What the agent should accomplish
// ============================================================================

export interface Scenario {
  /** Natural language goal */
  goal: string;
  /** Starting URL (optional - uses current page if not set) */
  startUrl?: string;
  /** Max turns before giving up */
  maxTurns?: number;
  /** Abort signal for external cancellation (e.g., story timeout) */
  signal?: AbortSignal;
}

// ============================================================================
// Configuration
// ============================================================================

export interface AgentConfig {
  /** LLM model (default: gpt-4o) */
  model?: string;
  /** API key (defaults to OPENAI_API_KEY) */
  apiKey?: string;
  /** Custom API base URL (for Anthropic, local models, etc.) */
  baseUrl?: string;
  /** Enable debug logging */
  debug?: boolean;
  /** Enable vision/multimodal (screenshots sent to LLM). Default: true */
  vision?: boolean;
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
  /** Time taken for this turn in ms */
  durationMs: number;
  /** Error message if turn failed */
  error?: string;
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
  /** Quality evaluation (if qualityThreshold is set or agent used "evaluate" action) */
  evaluation?: {
    score: number;
    assessment: string;
    strengths: string[];
    issues: string[];
    suggestions: string[];
  };
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
  /** Max turns allowed (default: 30) */
  maxTurns?: number;
  /** Timeout in ms */
  timeoutMs?: number;

  // Orchestration
  /** Priority (lower = runs first) */
  priority?: number;
  /** IDs of prerequisite test cases that must pass first */
  dependsOn?: string[];

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
  /** Duration in ms */
  durationMs: number;
  startedAt: Date;
  endedAt: Date;
  /** Screenshots captured during execution */
  screenshots?: { turn: number; base64: string }[];
  /** Whether this test was skipped (unmet dependencies) */
  skipped?: boolean;
  skipReason?: string;
}

export interface TestSuiteResult {
  /** Model used */
  model: string;
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
