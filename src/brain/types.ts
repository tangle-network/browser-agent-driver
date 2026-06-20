/**
 * Public result types for the LLM decision engine plus the internal
 * UserContent shape. BrainDecision/QualityEvaluation/LinkScoutRecommendation are
 * re-exported from brain/index.ts so existing import paths stay valid.
 */

import type { Action } from '../types.js';

export interface BrainDecision {
  action: Action;
  nextActions?: Action[];
  raw: string;
  reasoning?: string;
  plan?: string[];
  currentStep?: number;
  expectedEffect?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt-cache hit tokens (provider-agnostic). Reads from the AI SDK's
   * unified `usage.inputTokenDetails.cacheReadTokens` field. Populated by:
   *   - OpenAI / ZAI / GLM via automatic server-side caching
   *   - Anthropic via the cache_control markers set in buildSystemForDecide
   */
  cacheReadInputTokens?: number;
  /** Prompt-cache write tokens (cache miss, first turn — provider-agnostic) */
  cacheCreationInputTokens?: number;
  /** Which model handled this decision (for cost tracking with adaptive routing) */
  modelUsed?: string;
}

export interface QualityEvaluation {
  score: number;
  assessment: string;
  strengths: string[];
  issues: string[];
  suggestions: string[];
  raw: string;
  tokensUsed?: number;
}

export interface LinkScoutRecommendation {
  selector: string;
  reasoning: string;
  confidence: number;
  raw: string;
  tokensUsed?: number;
}

/** User message content — text-only or multimodal with screenshot */
export type UserContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType: string }>;
