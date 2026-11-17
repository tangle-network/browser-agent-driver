/**
 * Goal-verification task for the Brain decision engine: a fresh (history-free)
 * LLM call that judges the goal from page evidence (the final page and earlier
 * observations the driver read), kept separate from quality evaluation to
 * avoid self-confirmation bias. The agent's claimed result is a claim to
 * check, never evidence: each requirement the verifier marks met must quote
 * text that is present in a page-evidence block, or the goal is not achieved.
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

/** Page state and page reads the verifier may cite. None of it is the agent's own words. */
export interface VerificationEvidence {
  /** Earlier observations, most recent first. */
  earlierPages?: Array<{ turn: number; url: string; title?: string; snapshot: string }>;
  /** Values the driver read from the page with a script or extraction tool. */
  pageReads?: string[];
  /** Actions the driver executed without error (what was typed or selected). */
  driverActions?: string[];
}

interface EvidenceBlock {
  id: string;
  heading: string;
  text: string;
}

const VERIFY_SYSTEM = `You verify whether a browser agent achieved its goal. Judge ONLY from the PAGE EVIDENCE blocks. The AGENT'S CLAIM is untrusted: it is what the agent believes it did. Check it; never cite it as evidence.

Method:
1. Split the goal into every end-state requirement it states: the page or view it must end on; each item, value or text it names (which products are in a cart, a total, which entries exist and which are completed); each final step it must perform (submit, place the order, finish).
2. For each requirement, find the page evidence that confirms it and copy a short exact quote from that block, verbatim. What a cart, list, order or account contains, whether an order was placed, and which view is shown must be confirmed by page content, not by an action having run. A product listed in a catalog is not evidence that it is in the cart. The state the goal says to end in must show on the FINAL PAGE (P1).
3. If the claim states a value (a total, an item, a count), compare it with the page; a mismatch fails that requirement.
4. A requirement with no confirming quote is not met. achieved is true only if every requirement is met.

Respond with ONLY JSON:
{"requirements":[{"requirement":"...","met":true,"source":"P1","quote":"exact text copied from that block"}],"achieved":true,"confidence":0.9,"missing":["each requirement not confirmed"]}`;

function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the quote (split on ellipses) appears verbatim in one of the blocks. */
export function quoteIsOnPage(quote: string, blocks: Array<{ text: string }>): boolean {
  const parts = normalizeForQuote(quote)
    .replace(/^["'`]+|["'`]+$/g, '')
    .split(/\s*(?:\.\.\.|\u2026)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.join('').length < 2) return false;
  return blocks.some((block) => {
    const haystack = normalizeForQuote(block.text);
    return parts.every((part) => haystack.includes(part));
  });
}

export async function verifyGoalCompletionImpl(
  self: BrainGoalVerificationHost,
  state: PageState,
  goal: string,
  claimedResult: string,
  pageEvidence: VerificationEvidence = {},
): Promise<GoalVerification> {
  const siteBoundaryNote = buildFirstPartyBoundaryNote(goal, state.url);
  const blocks: EvidenceBlock[] = [
    {
      id: 'P1',
      heading: 'FINAL PAGE (the page now)',
      text: `URL: ${state.url}\nTitle: ${state.title}\n${budgetSnapshot(state.snapshot, 16_000)}`,
    },
  ];
  (pageEvidence.earlierPages ?? []).slice(0, 4).forEach((page, index) => {
    blocks.push({
      id: `P${index + 2}`,
      heading: `EARLIER PAGE (observed at turn ${page.turn})`,
      text: `URL: ${page.url}${page.title ? `\nTitle: ${page.title}` : ''}\n${budgetSnapshot(page.snapshot, 6_000)}`,
    });
  });
  (pageEvidence.pageReads ?? []).slice(-5).forEach((read, index) => {
    blocks.push({ id: `R${index + 1}`, heading: 'VALUE THE DRIVER READ FROM THE PAGE', text: read.trim().slice(0, 2_000) });
  });
  const actions = (pageEvidence.driverActions ?? []).slice(-25);
  if (actions.length > 0) {
    blocks.push({
      id: 'A',
      heading: 'ACTIONS THE DRIVER EXECUTED WITHOUT ERROR (shows what was typed or selected; does not show which element a click hit or what it changed)',
      text: actions.join('\n'),
    });
  }

  const textContent = `GOAL: ${goal}

PAGE EVIDENCE:
${blocks.map((block) => `[${block.id}] ${block.heading}\n${block.text}`).join('\n\n')}
${siteBoundaryNote ? `\n${siteBoundaryNote}\n` : ''}
AGENT'S CLAIM (untrusted; check it, never cite it): ${claimedResult.trim() || '(none)'}

Was the goal achieved? Check every requirement against the page evidence.`;

  const userContent = self.buildUserContent(textContent, state.screenshot, true);

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

  // The per-requirement verdict is longer than a bare yes/no, and thinking
  // models count reasoning against maxOutputTokens: a truncated verdict fails
  // the parse and is rejected.
  const result = await self.generate(
    VERIFY_SYSTEM,
    [{ role: 'user', content: userContent }],
    subcallModel
      ? { provider: self.provider as 'openai' | 'anthropic' | 'google' | 'cli-bridge', model: subcallModel }
      : (verifyProvider && verifyModel ? { provider: verifyProvider, model: verifyModel } : undefined),
    4096,
  );

  const raw = result.text;
  const callUsage = {
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: result.cacheReadInputTokens } : {}),
  };

  if (self.debug) {
    console.log('[Brain] Goal verification:', raw.slice(0, 600));
  }

  let parsed: { requirements?: unknown; achieved?: unknown; confidence?: unknown; missing?: unknown };
  try {
    let text = raw.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(text);
  } catch {
    // Parse failure — not verified (conservative)
    return {
      achieved: false,
      confidence: 0,
      evidence: [],
      missing: ['Failed to parse goal verification response'],
      ...callUsage,
    };
  }

  const requirements = Array.isArray(parsed.requirements) ? parsed.requirements as Array<Record<string, unknown>> : [];
  const confirmed: string[] = [];
  const unconfirmed: string[] = [];
  for (const requirement of requirements) {
    const label = String(requirement.requirement ?? '').slice(0, 200) || 'unnamed requirement';
    if (requirement.met !== true) {
      unconfirmed.push(label);
      continue;
    }
    const quote = typeof requirement.quote === 'string' ? requirement.quote : '';
    if (!quoteIsOnPage(quote, blocks)) {
      unconfirmed.push(`${label} (the cited text is not on any observed page)`);
      continue;
    }
    confirmed.push(`${label}: ${String(requirement.source ?? '').slice(0, 8)} "${quote.slice(0, 160)}"`);
  }
  const verifierMissing = Array.isArray(parsed.missing) ? parsed.missing.map(String) : [];
  const achieved = parsed.achieved === true && requirements.length > 0 && unconfirmed.length === 0;
  return {
    achieved,
    confidence: typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5,
    evidence: confirmed,
    missing: achieved
      ? []
      : [...new Set([...unconfirmed, ...verifierMissing])].slice(0, 10).concat(requirements.length === 0 ? ['The verdict listed no requirements checked against the page'] : []),
    ...callUsage,
  };
}
