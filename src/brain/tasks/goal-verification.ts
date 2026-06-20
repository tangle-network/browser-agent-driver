/**
 * Goal-verification task for the Brain decision engine: a fresh (history-free)
 * LLM call that checks whether the agent's claimed result actually achieved the
 * goal, kept separate from quality evaluation to avoid self-confirmation bias.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * Brain.verifyGoalCompletion keeps a thin delegator; the body lives here
 * verbatim and reads Brain state through {@link BrainGoalVerificationHost}, which
 * Brain `implements` so tsc proves the host surface is complete.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { PageState, GoalVerification } from '../../types.js';
import { buildFirstPartyBoundaryNote } from '../../domain-policy.js';
import { budgetSnapshot } from '../snapshot-budget.js';
import type { UserContent } from '../types.js';
import type { BrainProvider, ModelSelection, GenerateResult } from '../model-client.js';

/**
 * The slice of Brain state `verifyGoalCompletion` reads. All members are public
 * on Brain by construction; `implements BrainGoalVerificationHost` makes a
 * missing/mistyped member a compile error.
 */
export interface BrainGoalVerificationHost {
  provider: BrainProvider;
  debug: boolean;
  adaptiveModelRouting: boolean;
  navProvider?: BrainProvider;
  navModelName?: string;
  verifierProvider?: string;
  verifierModel?: string;
  buildUserContent(text: string, screenshot?: string, forceVision?: boolean): UserContent;
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

export async function verifyGoalCompletionImpl(
  self: BrainGoalVerificationHost,
  state: PageState,
  goal: string,
  claimedResult: string,
): Promise<GoalVerification> {
  const siteBoundaryNote = buildFirstPartyBoundaryNote(goal, state.url);
  const textContent = `GOAL: ${goal}

AGENT'S CLAIMED RESULT: ${claimedResult}

CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${budgetSnapshot(state.snapshot)}${siteBoundaryNote ? `\n\n${siteBoundaryNote}` : ''}

Was the goal actually achieved? Analyze the current page state carefully.`;

  const userContent = self.buildUserContent(textContent, state.screenshot, true);

  // Verifier can use its own model, then the navigation model, then main.
  const verifyProvider = self.verifierProvider
    ? self.verifierProvider as typeof self.provider
    : (self.adaptiveModelRouting && self.navModelName ? (self.navProvider || self.provider) : undefined);
  const verifyModel = self.verifierModel
    || (self.adaptiveModelRouting && self.navModelName ? self.navModelName : undefined);

  const result = await self.generate(
    `Verify whether the browser agent achieved its goal. Respond with ONLY JSON:
{"achieved":true,"confidence":0.9,"evidence":["observation"],"missing":[]}

Check: page state matches goal, no errors, URL is expected, claimed result matches visible data.
SUPPLEMENTAL TOOL EVIDENCE / SCRIPT RESULT in claimed results = verified DOM data, trustworthy even if page navigated away. Multi-page data collection is valid.`,
    [{ role: 'user', content: userContent }],
    verifyProvider && verifyModel ? { provider: verifyProvider, model: verifyModel } : undefined,
    600,
  );

  const raw = result.text;

  if (self.debug) {
    console.log('[Brain] Goal verification:', raw.slice(0, 300));
  }

  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    return {
      achieved: parsed.achieved === true,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    };
  } catch {
    // Parse failure — assume not verified (conservative)
    return {
      achieved: false,
      confidence: 0,
      evidence: [],
      missing: ['Failed to parse goal verification response'],
    };
  }
}
