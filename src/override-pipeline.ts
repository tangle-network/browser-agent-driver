/**
 * Override Pipeline — scored selection of post-decision action overrides.
 *
 * Replaces the 11 sequential if-checks in the runner loop with a single
 * scored pipeline that collects all candidates and picks the highest-scoring one.
 *
 * Each OverrideProducer examines the current context and optionally returns
 * an OverrideCandidate. The pipeline selects the candidate with the highest score.
 */

import type { Action, PageState } from './types.js';

export interface OverrideCandidate {
  name: string;
  action: Action;
  expectedEffect: string;
  feedback: string;
  score: number;
  /** Override prefix tag for the reasoning annotation (e.g. 'POLICY OVERRIDE', 'SCOUT OVERRIDE') */
  reasoningTag: string;
}

export interface OverrideContext {
  state: PageState;
  goal: string;
  allowedDomains?: string[];
  action: Action;
  visibleLinkMatch?: { ref: string; text: string; score: number };
  scoutLinkRecommendation?: { ref: string; text: string; confidence: number; reasoning: string };
  branchLinkRecommendation?: { ref: string; text: string; confidence: number; reasoning: string };
  aiTanglePartnerCompletion?: { result: string; feedback: string };
  aiTangleOutputCompletion?: { result: string; feedback: string };
}

/** Each override function returns a candidate or undefined */
export type OverrideProducer = (ctx: OverrideContext) => OverrideCandidate | undefined;

/**
 * Collect all candidates from the registered producers and pick the highest-scoring one.
 */
export function runOverridePipeline(
  ctx: OverrideContext,
  producers: OverrideProducer[],
): OverrideCandidate | undefined {
  const candidates: OverrideCandidate[] = [];

  for (const producer of producers) {
    const candidate = producer(ctx);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0) return undefined;

  // Sort by score descending, return highest
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}
