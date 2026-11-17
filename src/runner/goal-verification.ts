/**
 * Goal verification — the page evidence a completion is judged against, and
 * the content-type mismatch check.
 */

import type { PageState } from '../types.js';
import type { VerificationEvidence } from '../brain/tasks/goal-verification.js';
import {
  requiresPressReleaseLikeContent,
  NON_RELEASE_CONTENT_RE,
  NON_RELEASE_URL_RE,
  PRESS_RELEASE_RE,
} from './utils.js';

/**
 * The page evidence the goal verifier may cite: the latest observation of each
 * other URL the run visited (most recent first), values the driver read from
 * the page, and the actions the driver executed without error. The agent's
 * own result text is not part of it.
 */
export function collectPageEvidence(
  turns: Array<{ turn: number; state: PageState; action: { action: string }; executedActions?: Array<{ action: string }>; error?: string }>,
  finalState: PageState,
  pageReads: string[],
): VerificationEvidence {
  const earlierPages: NonNullable<VerificationEvidence['earlierPages']> = [];
  const seen = new Set([finalState.url]);
  for (let index = turns.length - 1; index >= 0 && earlierPages.length < 4; index -= 1) {
    const { state, turn } = turns[index]!;
    if (!state?.url || seen.has(state.url) || !state.snapshot) continue;
    seen.add(state.url);
    earlierPages.push({ turn, url: state.url, title: state.title, snapshot: state.snapshot });
  }
  const driverActions = turns
    .filter((turn) => !turn.error)
    .flatMap((turn) => turn.executedActions?.length ? turn.executedActions : [turn.action])
    .filter((action) => action.action !== 'complete' && action.action !== 'abort')
    .map((action) => JSON.stringify(action));
  return { earlierPages, pageReads, driverActions };
}

export function detectCompletionContentTypeMismatch(
  goal: string,
  state: PageState,
  claimedResult: string,
  evidence: string[],
): string | undefined {
  if (!requiresPressReleaseLikeContent(goal)) return undefined;

  const combined = [
    state.url,
    state.title,
    state.snapshot,
    claimedResult,
    ...evidence,
  ].join('\n').toLowerCase();

  const releaseLike = PRESS_RELEASE_RE.test(combined) || /\/news-releases?\//.test(combined);
  if (releaseLike) return undefined;

  const mismatchedContent = NON_RELEASE_CONTENT_RE.test(combined)
    || NON_RELEASE_URL_RE.test(combined);
  if (!mismatchedContent) return undefined;

  return 'The current page/result is not a press release or news release. Continue until the completion evidence points to an actual release page or release listing.';
}
