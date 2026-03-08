/**
 * Goal verification — helpers for verifying completion claims, search workflow
 * evidence collection, and script-backed completion acceptance.
 */

import type { PageState } from '../types.js';
import {
  requiresSearchWorkflowEvidence,
  requiresPressReleaseLikeContent,
  normalizeLooseText,
  extractRelevantSnapshotExcerpt,
  NON_RELEASE_CONTENT_RE,
  NON_RELEASE_URL_RE,
  PRESS_RELEASE_RE,
} from './utils.js';

const MAX_GOAL_VERIFICATION_EVIDENCE = 5;

export function buildGoalVerificationClaim(claimedResult: string, evidence: string[]): string {
  const cleanClaim = claimedResult.trim();
  if (evidence.length === 0) {
    return cleanClaim;
  }

  const recentEvidence = evidence
    .slice(-MAX_GOAL_VERIFICATION_EVIDENCE)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (recentEvidence.length === 0) {
    return cleanClaim;
  }

  return [
    cleanClaim,
    'SUPPLEMENTAL TOOL EVIDENCE:',
    ...recentEvidence,
  ].filter(Boolean).join('\n\n');
}

export function collectSearchWorkflowEvidence(
  goal: string,
  claimedResult: string,
  turns: Array<{ state: PageState }>,
): string[] {
  if (!requiresSearchWorkflowEvidence(goal)) return [];

  const queries = Array.from(goal.matchAll(/"([^"]{3,})"/g))
    .map((match) => match[1]?.trim())
    .filter((query): query is string => Boolean(query));
  if (queries.length === 0) return [];

  const claimedTitle = claimedResult.match(/(?:^|\n)\s*title:\s*(.+)/i)?.[1]?.trim();
  const claimedDate = claimedResult.match(/(?:^|\n)\s*(?:publication )?date:\s*(.+)/i)?.[1]?.trim();
  const normalizedTitle = claimedTitle ? normalizeLooseText(claimedTitle) : '';
  const normalizedDate = claimedDate?.toLowerCase() ?? '';

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const priorState = turns[index]?.state;
    if (!priorState) continue;

    const snapshot = priorState.snapshot;
    const snapshotLower = snapshot.toLowerCase();
    const matchedQuery = queries.find((query) => snapshotLower.includes(`[value="${query.toLowerCase()}"]`));
    if (!matchedQuery) continue;

    const hasTitle = Boolean(normalizedTitle) && normalizeLooseText(snapshot).includes(normalizedTitle);
    const hasDate = Boolean(normalizedDate) && snapshotLower.includes(normalizedDate);
    if (!hasTitle && !hasDate) continue;

    const relevantTerms = [matchedQuery, claimedTitle, claimedDate].filter((term): term is string => Boolean(term));
    return [
      [
        'SEARCH WORKFLOW EVIDENCE:',
        `URL: ${priorState.url}`,
        `Query visible in site search: ${matchedQuery}`,
        hasTitle && claimedTitle ? `Visible title evidence: ${claimedTitle}` : undefined,
        hasDate && claimedDate ? `Visible date evidence: ${claimedDate}` : undefined,
        `Snapshot excerpt:\n${extractRelevantSnapshotExcerpt(snapshot, relevantTerms)}`,
      ].filter(Boolean).join('\n'),
    ];
  }

  return [];
}

export function shouldAcceptSearchWorkflowCompletion(
  goal: string,
  verification: import('../types.js').GoalVerification,
  claimedResult: string,
  evidence: string[],
): boolean {
  if (verification.achieved) return false;
  if (!requiresSearchWorkflowEvidence(goal)) return false;

  const verifierText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const missingSearchState = [
    /search feature/,
    /search field/,
    /field is empty/,
    /current final page state/,
    /filtered search-results state/,
    /search-results state/,
    /using the site's search/,
  ].some((pattern) => pattern.test(verifierText));
  if (!missingSearchState) return false;

  const searchEvidence = evidence.find((entry) => entry.startsWith('SEARCH WORKFLOW EVIDENCE:'));
  if (!searchEvidence) return false;

  const claimLower = claimedResult.toLowerCase();
  return (
    /title:\s*/i.test(claimedResult)
    && /date:\s*/i.test(claimedResult)
    && (claimLower.includes('http://') || claimLower.includes('https://'))
  );
}

export function shouldAcceptScriptBackedCompletion(
  goal: string,
  state: PageState,
  verification: import('../types.js').GoalVerification,
  claimedResult: string,
  evidence: string[],
): boolean {
  if (verification.achieved) return false;

  const verifierText = [...verification.evidence, ...verification.missing].join('\n').toLowerCase();
  const visibilityLimited = [
    /accessibility tree/,
    /not visible/,
    /not shown/,
    /cannot verify/,
    /not present/,
    /visible publication date/,
    /no .* visible/,
    /does not show/,
    /missing/,
    /not found/,
    /not currently/,
  ].some((pattern) => pattern.test(verifierText));
  if (!visibilityLimited) return false;

  const scriptEvidence = evidence
    .filter((entry) => entry.startsWith('SCRIPT RESULT:'))
    .join('\n');
  if (!scriptEvidence) return false;

  const claimLower = claimedResult.toLowerCase();
  const hasUrlEvidence = state.url.length > 0 && claimLower.includes(state.url.toLowerCase());
  // Also accept if the claim references ANY URL (agent may have navigated away from extraction page)
  const hasAnyUrlEvidence = /https?:\/\/[^\s]+/.test(claimLower);
  const combinedEvidence = `${state.url}\n${state.title}\n${claimLower}\n${scriptEvidence}\n${verifierText}`.toLowerCase();

  if (requiresPressReleaseLikeContent(goal)) {
    const explicitlyNotRelease = /\bnot a press release page\b|\bnot a press release\b/.test(verifierText);
    const releaseLikeEvidence = PRESS_RELEASE_RE.test(combinedEvidence) || /\/news-releases?\//.test(combinedEvidence);
    if (explicitlyNotRelease || !releaseLikeEvidence) {
      return false;
    }
  }

  const tokenMatches = scriptEvidence.match(/[A-Z][a-z]+ \d{1,2}, \d{4}|\b\d{4}\b|\"[^\"]{6,}\"/g) ?? [];
  const normalizedTokens = tokenMatches
    .map((token) => token.replace(/^"|"$/g, '').trim().toLowerCase())
    .filter((token, index, all) => token.length >= 4 && all.indexOf(token) === index);
  const overlappingTokens = normalizedTokens.filter((token) => claimLower.includes(token));

  // Accept if: (current URL in claim OR any URL in claim) AND script evidence overlaps with claim
  return (hasUrlEvidence || hasAnyUrlEvidence) && overlappingTokens.length >= 1;
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
