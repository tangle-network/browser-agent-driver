/**
 * Recovery strategies for common failure modes.
 *
 * Automatically triggered by the Runner when it detects patterns like:
 * - Stuck (same URL + snapshot for multiple turns)
 * - Consecutive selector failures
 * - Loading states
 * - Blocking overlays
 */

import type { PageState, Turn } from './types.js';

export interface RecoveryContext {
  /** Recent turns for pattern analysis */
  recentTurns: Turn[];
  /** Current page state */
  currentState: PageState;
  /** Number of consecutive errors */
  consecutiveErrors: number;
}

export interface RecoveryAction {
  /** What strategy was triggered */
  strategy: string;
  /** Feedback to inject into the brain's conversation */
  feedback: string;
  /** Milliseconds to wait before continuing */
  waitMs?: number;
  /** Concrete action for the runner to execute before continuing */
  forceAction?: 'reload' | 'escape' | 'scrollTop';
}

/**
 * Compute a simple hash of a snapshot string for change detection.
 * Uses a fast DJB2-like hash — not cryptographic, just for equality checks.
 */
export function snapshotHash(snapshot: string): number {
  let hash = 5381;
  for (let i = 0; i < snapshot.length; i++) {
    hash = ((hash << 5) + hash + snapshot.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Detect if the agent is stuck (same URL + similar snapshot for N turns).
 */
export function detectStuck(turns: Turn[], threshold = 3): boolean {
  if (turns.length < threshold) return false;

  const recent = turns.slice(-threshold);
  const firstUrl = recent[0].state.url;
  const firstHash = snapshotHash(recent[0].state.snapshot);

  return recent.every(
    (t) => t.state.url === firstUrl && snapshotHash(t.state.snapshot) === firstHash
  );
}

/**
 * Detect consecutive action failures (selector not found, click intercepted, etc.)
 */
export function detectSelectorFailures(turns: Turn[], threshold = 2): boolean {
  if (turns.length < threshold) return false;
  const recent = turns.slice(-threshold);
  return recent.every((t) => !!t.error);
}

/**
 * Detect loading states in the snapshot.
 * Patterns are anchored to avoid false-positives on words like "downloading" or
 * "loading" appearing in regular page content (e.g., "Loading dock", "Processing fees").
 */
export function detectLoadingState(snapshot: string): boolean {
  const loadingPatterns = [
    /\bloading\.{2,3}/i,            // "Loading..." or "Loading.." (ellipsis = spinner text)
    /\bspinner\b/i,                  // explicit spinner element
    /\bplease wait\b/i,              // "Please wait"
    /\bfetching data\b/i,            // "Fetching data" (not just "fetching")
    /\bProcessing\.\.\./i,           // "Processing..." (with ellipsis)
    /\bProvisioning\s+(?:your|the|a)\b/i, // "Provisioning your container" etc.
    /\bCreating development environment\b/i,
  ];
  return loadingPatterns.some((p) => p.test(snapshot));
}

/**
 * Analyze the current state and return a recovery action if needed.
 * Returns null if no recovery is warranted.
 */
export function analyzeRecovery(ctx: RecoveryContext): RecoveryAction | null {
  const { recentTurns, currentState, consecutiveErrors } = ctx;

  // Strategy 1: Stuck detection — same page for 3+ turns (check BEFORE loading,
  // because a stuck loading state should escalate to reload, not just wait again)
  if (detectStuck(recentTurns, 3)) {
    const lastActions = recentTurns.slice(-3).map((t) => JSON.stringify(t.action));
    const allSame = lastActions.every((a) => a === lastActions[0]);

    if (allSame) {
      return {
        strategy: 'stuck-same-action',
        feedback:
          'STUCK: You have repeated the same action 3 times with no effect. ' +
          'The page has not changed. The page has been reloaded to reset state. ' +
          'You MUST try a completely different approach.',
        waitMs: 1000,
        forceAction: 'reload',
      };
    }

    return {
      strategy: 'stuck-no-progress',
      feedback:
        'STUCK: The page has not changed for 3 turns despite different actions. ' +
        'Escape has been pressed to dismiss any overlays. ' +
        'Try a fundamentally different approach — scroll, use different selectors, or navigate elsewhere.',
      forceAction: 'escape',
    };
  }

  // Strategy 2: Loading state — wait and re-observe instead of acting
  // (only if not already stuck — avoids masking stuck detection)
  if (detectLoadingState(currentState.snapshot)) {
    return {
      strategy: 'loading-wait',
      feedback: 'The page appears to be loading. Waiting for it to finish before taking action.',
      waitMs: 3000,
    };
  }

  // Strategy 3: Consecutive selector failures
  if (consecutiveErrors >= 2 || detectSelectorFailures(recentTurns, 2)) {
    return {
      strategy: 'selector-failures',
      feedback:
        'Multiple actions have failed. The selectors may be stale or elements may be obscured. ' +
        'Look carefully at the current ELEMENTS list and choose a different element. ' +
        'Consider dismissing any overlay first.',
    };
  }

  return null;
}
