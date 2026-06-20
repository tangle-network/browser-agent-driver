import type { Action } from './actions.js';
import type { PageState } from './page.js';

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
