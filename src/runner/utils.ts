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

/**
 * Cap a feedback payload injected into the brain's next-turn context.
 * Extraction actions (runScript / extractWithIndex) can return page-sized
 * blobs; feeding them back uncapped re-bills the full blob as input tokens
 * on every subsequent turn. The evidence ledger keeps the full text — this
 * cap only bounds what the model re-reads.
 */
export function capFeedbackText(text: string, maxChars = 1000): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n… [${omitted} chars truncated — query the page again if you need more]`;
}

/**
 * Sanitize a model-emitted runScript payload before page.evaluate.
 *
 * Two failure classes seen in bench runs:
 *   1. Phantom refs: the model queries `document.querySelector('[ref=t1f2a]')`
 *      — refs exist only in our aria snapshot, not the DOM, so the query
 *      matches nothing and the model loops guessing similar selectors
 *      (the hn-top-story-score death spiral). Reject outright with an
 *      explanation the model can act on.
 *   2. Bare top-level `return`: page.evaluate(script) evaluates the string
 *      with eval semantics, where a top-level return is a SyntaxError and
 *      the turn dies. Scripts that use return (and aren't already an IIFE)
 *      are wrapped in one. Expression-style scripts stay untouched so their
 *      completion value still reaches the caller.
 */
export function sanitizeRunScript(
  script: string,
): { ok: true; script: string } | { ok: false; error: string } {
  if (/\[\s*ref\s*=/.test(script)) {
    return {
      ok: false,
      error:
        'SCRIPT REJECTED: [ref=...] selectors are aria-snapshot refs, not DOM attributes — document.querySelector cannot see them. ' +
        'Use CSS selectors, [data-testid="..."], [aria-label="..."], or the extractWithIndex action instead.',
    };
  }
  const trimmed = script.trim();
  const looksInvoked = trimmed.startsWith('(') || /^(async\s+)?function\b/.test(trimmed);
  if (/\breturn\b/.test(trimmed) && !looksInvoked) {
    return { ok: true, script: `(() => { ${trimmed} })()` };
  }
  return { ok: true, script };
}

// ── Premature-surrender guard (wave 6) ──────────────────────────────────

/**
 * Hard-blocked page detection for the surrender guard's exemption. Only
 * well-known hard blocks exempt an early abort: navigation failures,
 * anti-bot interstitials, and access-denied walls. Conservative on
 * purpose — a healthy page with data visible must never qualify (the
 * wave-5 surrender case was exactly that).
 */
export function pageLooksBlocked(state: { url?: string; snapshot?: string }): boolean {
  const url = String(state.url ?? '');
  if (url.startsWith('chrome-error://')) return true;
  const text = String(state.snapshot ?? '').toLowerCase();
  const markers = [
    'just a moment...',
    'verifying you are human',
    'checking your browser before',
    'cloudflare ray id',
    'cf-chl-',
    'cf-mitigated',
    'recaptcha',
    'hcaptcha',
    'please complete the captcha',
    'access denied',
    '403 forbidden',
    '429 too many requests',
  ];
  return markers.some((m) => text.includes(m));
}

/**
 * The surrender decision: an abort with (nearly) zero executed actions and
 * zero extraction evidence on a reachable page is a confabulation, not a
 * verdict — the wave-5 dashboard-extract weather window aborted at turn 1
 * on a byte-identical healthy snapshot because the model invented a
 * "previous failed run". Reject it and re-prompt toward the observation.
 *
 * Threshold: turns.length < 2 covers turn-1 aborts and turn-2 aborts after
 * a no-op first turn, while leaving genuine quick-exit paths (blocked
 * page, or any evidence-bearing attempt) alone.
 */
export function shouldRejectSurrender(input: {
  actionType: string;
  executedTurns: number;
  evidenceCount: number;
  state: { url?: string; snapshot?: string };
}): boolean {
  if (input.actionType !== 'abort') return false;
  if (input.executedTurns >= 2) return false;
  if (input.evidenceCount > 0) return false;
  return !pageLooksBlocked(input.state);
}
