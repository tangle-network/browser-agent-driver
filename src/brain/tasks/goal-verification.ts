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
  options?: {
    /** When the run already holds deterministic DOM evidence (SCRIPT
     *  RESULT entries, included in the claim), skip the fresh 24k-token
     *  page snapshot and the forced screenshot — the evidence is the
     *  ground truth the verifier needs, the page may have navigated on. */
    skipPageState?: boolean;
  },
): Promise<GoalVerification> {
  const skipPageState = options?.skipPageState === true;
  const siteBoundaryNote = skipPageState ? '' : buildFirstPartyBoundaryNote(goal, state.url);
  const pageBlock = skipPageState
    ? ''
    : `CURRENT PAGE:
URL: ${state.url}
Title: ${state.title}

ELEMENTS:
${budgetSnapshot(state.snapshot)}`;
  const textContent = `GOAL: ${goal}

AGENT'S CLAIMED RESULT: ${claimedResult}

${pageBlock}${siteBoundaryNote ? `\n\n${siteBoundaryNote}` : ''}
Was the goal actually achieved? Analyze the ${skipPageState ? 'claimed result and its embedded evidence' : 'current page state'} carefully.`;

  const userContent = skipPageState
    ? self.buildUserContent(textContent)
    : self.buildUserContent(textContent, state.screenshot, true);

  // Verifier can use its own model, then the navigation model, then main.
  // BAD_SUBCALL_MODEL routes execution-shaped sub-calls (verification;
  // decide is NEVER sub-routed) to a cheaper model — the Alumnium pattern.
  // Default is the primary model; adoption requires a bench arm showing
  // pass rate holds.
  const subcallModel = process.env.BAD_SUBCALL_MODEL?.trim();
  const verifyProvider = self.verifierProvider
    ? self.verifierProvider as typeof self.provider
    : (self.adaptiveModelRouting && self.navModelName ? (self.navProvider || self.provider) : undefined);
  const verifyModel = subcallModel
    || self.verifierModel
    || (self.adaptiveModelRouting && self.navModelName ? self.navModelName : undefined);

  const result = await self.generate(
    `Verify whether the browser agent achieved its goal. Respond with ONLY JSON:
{"achieved":true,"confidence":0.9,"evidence":["observation"],"missing":[]}

Check: page state matches goal, no errors, URL is expected, claimed result matches visible data.
SUPPLEMENTAL TOOL EVIDENCE / SCRIPT RESULT in claimed results = verified DOM data, trustworthy even if page navigated away. Multi-page data collection is valid.`,
    [{ role: 'user', content: userContent }],
    subcallModel
      ? { provider: self.provider as 'openai' | 'anthropic' | 'google' | 'cli-bridge', model: subcallModel }
      : (verifyProvider && verifyModel ? { provider: verifyProvider, model: verifyModel } : undefined),
    // Gemini thinking tokens count against maxOutputTokens — at 600 the
    // verdict JSON starves and truncation fails the parse (conservative
    // reject), which reprompts the agent and was silently breaking replay's
    // single verification call. Match the decide cap for google.
    self.provider === 'google' ? 4096 : 600,
  );

  const raw = result.text;
  const callUsage = {
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: result.cacheReadInputTokens } : {}),
  };

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
      ...callUsage,
    };
  } catch {
    // Parse failure — assume not verified (conservative)
    return {
      achieved: false,
      confidence: 0,
      evidence: [],
      missing: ['Failed to parse goal verification response'],
      ...callUsage,
    };
  }
}
