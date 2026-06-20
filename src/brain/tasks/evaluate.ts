/**
 * Quality-evaluation task for the Brain decision engine: asks the LLM to rate
 * the visual quality, design, and professional polish of the current page.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * Brain.evaluate keeps a thin delegator; the body lives here verbatim and reads
 * Brain state through {@link BrainEvaluateHost}, which Brain `implements` so tsc
 * proves the host surface is complete.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { PageState } from '../../types.js';
import { EVALUATE_PROMPT } from '../prompts.js';
import type { QualityEvaluation, UserContent } from '../types.js';
import type { ModelSelection, GenerateResult } from '../model-client.js';

/**
 * The slice of Brain state `evaluate` reads. All members are public on Brain by
 * construction; `implements BrainEvaluateHost` makes a missing/mistyped member a
 * compile error.
 */
export interface BrainEvaluateHost {
  debug: boolean;
  buildUserContent(text: string, screenshot?: string, forceVision?: boolean): UserContent;
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

export async function evaluateImpl(self: BrainEvaluateHost, state: PageState, goal: string): Promise<QualityEvaluation> {
  const textContent = `GOAL that was being worked on: ${goal}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

Please evaluate the quality of this page/application.`;

  const userContent = self.buildUserContent(textContent, state.screenshot, true);

  const result = await self.generate(
    EVALUATE_PROMPT,
    [{ role: 'user', content: userContent }],
    undefined,
    800,
  );

  const raw = result.text;
  const tokensUsed = result.tokensUsed;

  if (self.debug) {
    console.log('[Brain] Evaluation:', raw.slice(0, 300));
  }

  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    const rawScore = typeof parsed.score === 'number' ? parsed.score : 5;
    return {
      score: Math.max(1, Math.min(10, rawScore)),
      assessment: parsed.assessment ?? 'No assessment provided',
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      raw,
      tokensUsed,
    };
  } catch {
    return {
      score: 5,
      assessment: 'Failed to parse evaluation response',
      strengths: [],
      issues: [],
      suggestions: [],
      raw,
      tokensUsed,
    };
  }
}
