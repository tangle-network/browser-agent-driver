import type { Action } from './actions.js';
import type { ReplayConfig } from '../runner/replay/contracts.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AgentConfig {
  /** LLM provider: 'openai' (default), 'anthropic', 'google', 'cli-bridge', 'codex-cli', 'claude-code', 'sandbox-backend', or 'zai-coding-plan' */
  provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
  /** LLM model (default: gpt-5.4) */
  model?: string;
  /** Enable adaptive model routing for decide() (default: false) */
  adaptiveModelRouting?: boolean;
  /** Fast navigation model used when adaptive routing is enabled */
  navModel?: string;
  /** Provider for navModel (defaults to provider) */
  navProvider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';

  /** Per-role model overrides. Each role falls back to the main model/provider. */
  models?: {
    /** Planner — needs best reasoning. Default: main model. */
    planner?: { model: string; provider?: string };
    /** Executor — follows plans, can be cheap. Default: navModel or main model. */
    executor?: { model: string; provider?: string };
    /** Verifier — structured yes/no. Default: navModel or main model. */
    verifier?: { model: string; provider?: string };
    /** Supervisor — strategic recovery. Default: main model. */
    supervisor?: { model: string; provider?: string };
  };
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
  /** Observation mode — 'dom' (default), 'vision', or 'hybrid' */
  observationMode?: 'dom' | 'vision' | 'hybrid';
  /**
   * Force `streamingInput: 'always'` on the `claude-code` provider (default:
   * false). The Claude Code SDK omits image parts unless streaming input is
   * enabled, so a `completeVision` round-trip through `claude-code` silently
   * drops its screenshots without this. Set ONLY by the vision-judge wiring
   * (`buildVisionModels`), whose Brains exist solely to send images — every
   * other claude-code path is left on the default single-shot prompt and is
   * unaffected. Ignored for non-`claude-code` providers.
   */
  claudeCodeStreamingInput?: boolean;
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
   * Plan-then-execute. When true, BrowserAgent.run() makes a single
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
   * Planner routing policy. `always` uses the planner whenever plannerEnabled
   * is true. `auto` routes extraction-style tasks through the per-action
   * observe→act loop.
   */
  plannerMode?: 'always' | 'auto';
  /** Extra wait before the planner's initial observe, in ms. Default: 0. */
  initialObserveSettleMs?: number;
  /**
   * ZERO-LLM workflow replay. When `enabled`, a strict-matched prior successful
   * trajectory is re-executed verbatim against the live page before the normal
   * loop; a self-heal abort falls through to per-action mode. OPT-IN (default
   * off / `--replay`) per experiment discipline. See src/runner/replay.
   */
  replay?: ReplayConfig;
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

  /** Parallel tab execution for compound goals */
  parallelTabs?: {
    /** Enable goal decomposition + parallel tab execution (default: false) */
    enabled?: boolean;
    /** Max parallel tabs (default: 3) */
    maxTabs?: number;
  };

  /** Override token budget (used internally by parallel runner to split budget) */
  tokenBudget?: number;
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
  provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
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
  provider?: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan';
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
