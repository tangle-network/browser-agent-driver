/**
 * Link-scout task for the Brain decision engine: given a goal and a ranked set
 * of deterministic link candidates, asks a cheap scout model to pick the single
 * best next visible link (with a deterministic top-candidate fallback on parse
 * failure).
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * Brain.recommendLinkCandidate keeps a thin delegator; the body lives here
 * verbatim and reads Brain state through {@link BrainLinkScoutHost}, which Brain
 * `implements` so tsc proves the host surface is complete.
 */

import type { ModelMessage, SystemModelMessage } from 'ai';
import type { PageState } from '../../types.js';
import { LINK_SCOUT_PROMPT } from '../prompts.js';
import type { LinkScoutRecommendation, UserContent } from '../types.js';
import type { BrainProvider, ModelSelection, GenerateResult } from '../model-client.js';

/**
 * The slice of Brain state `recommendLinkCandidate` reads. All members are
 * public on Brain by construction; `implements BrainLinkScoutHost` makes a
 * missing/mistyped member a compile error.
 */
export interface BrainLinkScoutHost {
  provider: BrainProvider;
  modelName: string;
  navProvider?: BrainProvider;
  navModelName?: string;
  scoutProvider?: BrainProvider;
  scoutModelName?: string;
  scoutUseVision: boolean;
  buildUserContent(text: string, screenshot?: string, forceVision?: boolean): UserContent;
  generate(
    system: string | SystemModelMessage[],
    messages: ModelMessage[],
    selection?: ModelSelection,
    maxOutputTokens?: number,
  ): Promise<GenerateResult>;
}

export async function recommendLinkCandidateImpl(
  self: BrainLinkScoutHost,
  goal: string,
  state: PageState,
  candidates: Array<{ ref: string; text: string; score: number }>,
  extraContext?: string,
): Promise<LinkScoutRecommendation> {
  const topCandidates = candidates.slice(0, 5);
  // Scout only needs candidates + context, not the full snapshot (saves 2-8k tokens)
  const lines = [
    `GOAL: ${goal}`,
    '',
    `PAGE: ${state.url} — ${state.title}`,
    '',
    'CANDIDATES:',
    ...topCandidates.map((candidate, index) =>
      `${index + 1}. ${candidate.ref} — ${candidate.text} (score ${candidate.score})`,
    ),
  ];
  if (extraContext) {
    lines.push('', extraContext);
  }
  lines.push('', 'Choose the single best next visible link.');

  const userContent = self.buildUserContent(
    lines.join('\n'),
    state.screenshot,
    self.scoutUseVision,
  );
  const provider = self.scoutProvider || self.navProvider || self.provider;
  const model = self.scoutModelName || self.navModelName || self.modelName;
  const result = await self.generate(
    LINK_SCOUT_PROMPT,
    [{ role: 'user', content: userContent }],
    { provider, model },
    300,
  );

  const raw = result.text;
  const tokensUsed = result.tokensUsed;

  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(text);
    const selector = typeof parsed.selector === 'string' ? parsed.selector.trim() : '';
    const candidate = topCandidates.find((entry) => entry.ref === selector);
    if (!candidate) {
      throw new Error('invalid scout selector');
    }
    return {
      selector,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No scout reasoning provided.',
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      raw,
      tokensUsed,
    };
  } catch {
    const fallback = topCandidates[0];
    if (!fallback) {
      throw new Error('recommendLinkCandidate requires at least one candidate');
    }
    return {
      selector: fallback.ref,
      reasoning: 'Scout fallback: selected the top deterministic candidate after parse failure.',
      confidence: 0.5,
      raw,
      tokensUsed,
    };
  }
}
