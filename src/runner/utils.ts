/**
 * Runner utility functions — retry logic, snapshot helpers, text normalization.
 */

import type { PageState } from '../types.js';

const DEFAULT_MAX_GOAL_VERIFICATION_EVIDENCE = 5;

/** Retry wrapper for transient failures. Respects AbortSignal between attempts. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number,
  onRetry?: (attempt: number, error: Error) => void,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error(signal.reason || 'Cancelled');
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        onRetry?.(attempt, lastError);
        await new Promise<void>((resolve, reject) => {
          let onAbort: (() => void) | undefined;
          const timer = setTimeout(() => {
            if (onAbort) signal?.removeEventListener('abort', onAbort);
            resolve();
          }, delayMs * attempt);
          if (signal) {
            onAbort = () => { clearTimeout(timer); reject(new Error(signal.reason || 'Cancelled')); };
            if (signal.aborted) { clearTimeout(timer); reject(new Error(signal.reason || 'Cancelled')); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
    }
  }

  throw lastError ?? new Error('withRetry: no attempts made');
}

/**
 * Extract the element identity (e.g., 'button "Send"') for a given @ref
 * from an a11y snapshot. Returns undefined if the ref is not found.
 */
export function findElementForRef(snapshot: string, selector: string): string | undefined {
  if (!selector.startsWith('@')) return undefined;
  const bareRef = selector.slice(1);
  // Match: role "name" [ref=XXX] in the snapshot
  const regex = new RegExp(`(\\w+ "[^"]*")\\s*\\[ref=${bareRef}\\]`);
  const match = snapshot.match(regex);
  return match?.[1];
}

export function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function requiresSearchWorkflowEvidence(goal: string): boolean {
  const goalLower = goal.toLowerCase();
  return (
    goalLower.includes("site's search feature")
    || goalLower.includes('\u2019s search feature')
    || goalLower.includes('site search')
  );
}

export function requiresPressReleaseLikeContent(goal: string): boolean {
  const goalLower = goal.toLowerCase();
  return PRESS_RELEASE_RE.test(goalLower);
}

/** Matches press-release / news-release mentions in text. */
export const PRESS_RELEASE_RE = /\bpress release\b|\bnews release\b/i;

/** Matches NIH non-release content signals (research matters, fact sheets, topic pages). */
export const NON_RELEASE_CONTENT_RE = /\bnih research matters\b|\bnews in health\b|\bcatalyst\b|\bfact sheet\b|\bwhat causes\b|\bwhat are the signs\b|\btreated\b/i;

/** Matches URL path patterns typical of non-release content pages. */
export const NON_RELEASE_URL_RE = /\/nih-research-matters\/|\/science-updates\/|\/health\/|\/research\/|\/blog\//i;

export function looksLikeSearchResultsPage(state: PageState): boolean {
  const haystack = `${state.url}\n${state.title}\n${state.snapshot}`.toLowerCase();
  return /\bsearch\b|\bsearch results\b|\bquery=/.test(haystack);
}

export function normalizeLooseText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function extractRelevantSnapshotExcerpt(snapshot: string, terms: string[]): string {
  const lines = snapshot.split('\n');
  const normalizedTerms = terms
    .map((term) => term.toLowerCase())
    .filter(Boolean);
  const matchingIndexes = lines
    .map((line, index) => ({ line: line.toLowerCase(), index }))
    .filter(({ line }) => normalizedTerms.some((term) => line.includes(term)))
    .map(({ index }) => index);

  if (matchingIndexes.length === 0) {
    return lines.slice(0, 12).join('\n');
  }

  const start = Math.max(0, matchingIndexes[0] - 2);
  const end = Math.min(lines.length, matchingIndexes[matchingIndexes.length - 1] + 3);
  return lines.slice(start, end).join('\n');
}

export function findLinkRefByExactText(snapshot: string, text: string): string | undefined {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(new RegExp(`- link "${escaped}" \\[ref=([^\\]]+)\\]`));
  return match?.[1] ? `@${match[1]}` : undefined;
}

export function findLinkRefContainingText(snapshot: string, text: string): string | undefined {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(new RegExp(`- link "([^"]*${escaped}[^"]*)" \\[ref=([^\\]]+)\\]`, 'i'));
  return match?.[2] ? `@${match[2]}` : undefined;
}

export function pushGoalVerificationEvidence(target: string[], entry: string): void {
  target.push(entry);
  if (target.length > DEFAULT_MAX_GOAL_VERIFICATION_EVIDENCE) {
    target.splice(0, target.length - DEFAULT_MAX_GOAL_VERIFICATION_EVIDENCE);
  }
}

export function hasFullDate(text: string): boolean {
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}\b/i.test(text);
}
