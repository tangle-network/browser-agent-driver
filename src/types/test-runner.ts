import type { AgentConfig } from './config.js';
import type { AgentResult, RunPhaseTimings, RunStartupDiagnostics, RunWasteMetrics } from './result.js';

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

/**
 * Current on-disk schema version for `report.json` / `TestSuiteResult`.
 *
 * Consumers that parse `<sink>/report.json` should pin or range-check this.
 * The contract: bump on any breaking shape change (removed fields, renamed
 * fields, changed value semantics). Adding an optional field is non-breaking
 * and does NOT bump the version.
 */
export const TEST_SUITE_SCHEMA_VERSION = '1' as const;

export interface TestSuiteResult {
  /**
   * On-disk schema version. See {@link TEST_SUITE_SCHEMA_VERSION}. Consumers
   * should verify this matches their expected version before destructuring.
   */
  schemaVersion: string;
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
