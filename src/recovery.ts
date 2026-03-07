/**
 * Recovery strategies for common failure modes.
 *
 * Automatically triggered by the Runner when it detects patterns like:
 * - Stuck (same URL + snapshot for multiple turns)
 * - Consecutive selector failures
 * - Loading states
 * - Blocking overlays
 */

import type { Action, PageState, Turn } from './types.js';

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
  /** Optional direct browser action to execute before continuing */
  forceBrowserAction?: Action;
}

export interface SnapshotElement {
  role: string;
  name: string;
  ref: string;
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

  // Classic stuck: identical state across all turns
  if (recent.every(
    (t) => t.state.url === firstUrl && snapshotHash(t.state.snapshot) === firstHash
  )) {
    return true;
  }

  // Oscillating stuck: same URL, alternating between two states (e.g., menu open/close)
  if (recent.length >= 4) {
    const last4 = turns.slice(-4);
    const sameUrl = last4.every((t) => t.state.url === firstUrl);
    if (sameUrl) {
      const hashes = last4.map((t) => snapshotHash(t.state.snapshot));
      const isOscillating = hashes[0] === hashes[2] && hashes[1] === hashes[3] && hashes[0] !== hashes[1];
      if (isOscillating) return true;
    }
  }

  // URL cycle detection: agent revisits the same URL sequence across different pages
  // Catches A→B→C→A→B→C and A→B→A→B patterns across different URLs
  if (turns.length >= 6) {
    const recentUrls = turns.slice(-6).map((t) => t.state.url);
    // Check for 2-cycle (A→B→A→B) across different URLs
    if (recentUrls[2] === recentUrls[4] && recentUrls[3] === recentUrls[5] && recentUrls[2] !== recentUrls[3]) {
      if (recentUrls[0] === recentUrls[2] && recentUrls[1] === recentUrls[3]) return true;
    }
    // Check for 3-cycle (A→B→C→A→B→C) across different URLs
    if (recentUrls[0] === recentUrls[3] && recentUrls[1] === recentUrls[4] && recentUrls[2] === recentUrls[5]) {
      const unique = new Set(recentUrls.slice(0, 3));
      if (unique.size >= 2) return true;
    }
  }

  return false;
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

/** Parse interactive elements from a snapshot into role/name/ref triples. */
export function parseSnapshotElements(snapshot: string): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  const lines = snapshot.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?.*\[ref=([^\]]+)\]/);
    if (!match) continue;
    const [, role, name = '', ref] = match;
    elements.push({ role: role.toLowerCase(), name: name.trim(), ref: ref.trim() });
  }

  return elements;
}

function pickRefByName(elements: SnapshotElement[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = elements.find((el) =>
      (el.role === 'button' || el.role === 'link' || el.role === 'menuitem') &&
      pattern.test(el.name.toLowerCase())
    );
    if (match) return match.ref;
  }
  return undefined;
}

function detectQuotaLimitText(snapshotLower: string): boolean {
  const patterns = [
    /project limit/,
    /limit reached/,
    /quota/,
    /usage limit/,
    /maximum .* reached/,
    /too many .* projects/,
    /upgrade .* plan/,
    /free up .* project/,
  ];
  return patterns.some((p) => p.test(snapshotLower));
}

export interface BlockingModalDetection {
  kind: 'quota-limit' | 'blocking-modal' | 'verification-override';
  strategy: string;
  feedback: string;
  action?: Action;
  forceAction?: 'escape';
}

export interface TerminalBlockerDetection {
  kind: 'network-unreachable' | 'bot-challenge' | 'dev-environment-unavailable';
  strategy: 'terminal-network-error' | 'terminal-bot-challenge' | 'terminal-dev-environment-unavailable';
  reason: string;
  evidence: string[];
}

/**
 * Detect blocking dialogs/modals and suggest an immediate remediation action.
 * This is intentionally deterministic so common blockers are handled without
 * waiting for the LLM to rediscover basic escape hatches every run.
 */
export function detectBlockingModal(snapshot: string): BlockingModalDetection | null {
  const snapshotLower = snapshot.toLowerCase();
  const hasDialog = /(?:^|\n)\s*-\s*(?:dialog|alertdialog)\b/i.test(snapshot);
  const hasModalWord = /\bmodal\b/i.test(snapshot);

  if (!hasDialog && !hasModalWord && !detectQuotaLimitText(snapshotLower)) {
    return null;
  }

  const elements = parseSnapshotElements(snapshot);

  const confirmDeleteRef = pickRefByName(elements, [
    /^delete$/,
    /^yes,\s*delete$/,
    /^confirm$/,
    /^remove$/,
  ]);
  const looksLikeProjectDeleteConfirm =
    /(?:delete|remove).*(?:project|item)/.test(snapshotLower) ||
    /are you sure/.test(snapshotLower) ||
    /permanently delete/.test(snapshotLower);
  if (looksLikeProjectDeleteConfirm && confirmDeleteRef) {
    return {
      kind: 'blocking-modal',
      strategy: 'modal-confirm-delete',
      feedback:
        'BLOCKER SUBSTEP: A delete-confirmation modal is present. Confirming deletion to complete quota cleanup, then continue the main goal.',
      action: { action: 'click', selector: `@${confirmDeleteRef}` },
    };
  }

  const verificationOverrideRef = pickRefByName(elements, [
    /use personal credits/,
    /continue with (?:your )?current project/,
    /continue with personal credits/,
    /continue anyway/,
    /proceed anyway/,
  ]);
  const looksLikeVerificationOverride =
    /\bverification error\b/.test(snapshotLower) ||
    /\bcouldn[’']t verify\b/.test(snapshotLower) ||
    /\bpartner['’]s requirements\b/.test(snapshotLower) ||
    /\buse personal credits\b/.test(snapshotLower);
  if (looksLikeVerificationOverride && verificationOverrideRef) {
    return {
      kind: 'verification-override',
      strategy: 'modal-use-personal-credits',
      feedback:
        'BLOCKER: A partner verification modal is blocking project start. Continue with the current project using personal credits, then resume the main goal.',
      action: { action: 'click', selector: `@${verificationOverrideRef}` },
    };
  }

  // Prefer non-destructive exits first, then cleanup actions if required.
  if (detectQuotaLimitText(snapshotLower)) {
    const manageRef = pickRefByName(elements, [
      /manage projects?/,
      /view projects?/,
      /open projects?/,
      /go to projects?/,
      /existing projects?/,
      /project settings/,
      /billing/,
      /upgrade/,
    ]);
    if (manageRef) {
      return {
        kind: 'quota-limit',
        strategy: 'quota-limit-manage',
        feedback:
          'BLOCKER: A quota/limit dialog is blocking progress. Opening the project/plan management path. ' +
          'Resolve the limit (remove/archive old test items or upgrade) and then retry the original goal action.',
        action: { action: 'click', selector: `@${manageRef}` },
      };
    }

    const cleanupRef = pickRefByName(elements, [
      /delete\s+(?:a\s+)?project/,
      /remove\s+(?:an?\s+)?project/,
      /archive\s+(?:an?\s+)?project/,
      /free up .*project/,
      /delete oldest project/,
      /remove oldest project/,
      /clear old projects?/,
    ]);
    if (cleanupRef) {
      return {
        kind: 'quota-limit',
        strategy: 'quota-limit-cleanup',
        feedback:
          'BLOCKER: A quota/limit dialog is blocking progress. A cleanup action was selected to free capacity. ' +
          'After cleanup, confirm the blocker is gone and continue with the main goal.',
        action: { action: 'click', selector: `@${cleanupRef}` },
      };
    }

    return {
      kind: 'quota-limit',
      strategy: 'quota-limit-escape',
      feedback:
        'BLOCKER: Quota/limit dialog detected but no clear management button was found. ' +
        'Dismissing the dialog; then navigate to project/settings areas to free capacity and retry.',
      forceAction: 'escape',
    };
  }

  // Cookie / consent banners — dismiss deterministically before the LLM wastes a turn.
  const isCookieConsent =
    /\bcookie/i.test(snapshotLower) ||
    /\bconsent/i.test(snapshotLower) ||
    /\bpersonalise your/i.test(snapshotLower) ||
    /\bpersonalize your/i.test(snapshotLower) ||
    /\bprivacy preference/i.test(snapshotLower);
  if (isCookieConsent) {
    const consentDismissRef = pickRefByName(elements, [
      /^reject all$/,
      /^decline all$/,
      /^deny$/,
      /^reject$/,
      /^accept all$/,
      /^allow all$/,
      /^accept cookies?$/,
      /^got it$/,
      /^ok$/,
      /^close$/,
      /^continue$/,
    ]);
    if (consentDismissRef) {
      return {
        kind: 'blocking-modal',
        strategy: 'cookie-consent-dismiss',
        feedback:
          'BLOCKER: A cookie/consent dialog was intercepting the page. It has been dismissed. ' +
          'If you submitted a form or search before this dialog appeared, the submission may have been blocked. ' +
          'Re-verify whether your last action took effect (check the URL and page content) and re-submit if needed.',
        action: { action: 'click', selector: `@${consentDismissRef}` },
      };
    }
  }

  const closeRef = pickRefByName(elements, [
    /^close$/,
    /dismiss/,
    /cancel/,
    /not now/,
    /maybe later/,
    /^ok$/,
    /^got it$/,
    /^continue$/,
    /skip/,
  ]);
  if (closeRef) {
    return {
      kind: 'blocking-modal',
      strategy: 'modal-dismiss-click',
      feedback:
        'BLOCKER: A dialog/modal is obstructing interaction. Dismiss it first, then continue with the goal.',
      action: { action: 'click', selector: `@${closeRef}` },
    };
  }

  return {
    kind: 'blocking-modal',
    strategy: 'modal-present-no-force',
    feedback:
      'BLOCKER: A dialog/modal is present. Do not interact with background page elements. ' +
      'Choose an explicit action inside this modal first (close, cancel, confirm, or required primary action).',
  };
}

/**
 * Detect blockers that should terminate the run immediately.
 * These are conditions the agent cannot reliably resolve by trying more actions.
 */
export function detectTerminalBlocker(state: PageState): TerminalBlockerDetection | null {
  const url = state.url || '';
  const title = state.title || '';
  const snapshot = state.snapshot || '';
  const haystack = `${url}\n${title}\n${snapshot}`.toLowerCase();

  const networkPatterns: Array<[string, RegExp]> = [
    ['chrome-error-url', /^chrome-error:\/\//i],
    ['site-unreachable', /\bthis site can['’]t be reached\b/i],
    ['name-not-resolved', /\berr_name_not_resolved\b/i],
    ['connection-failed', /\berr_(?:connection|internet|address)_/i],
    ['dns-failure', /\bdns_probe_finished\b/i],
    ['network-error', /\bnetwork error\b/i],
  ];
  const networkHits = networkPatterns
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([name]) => name);
  if (networkHits.length > 0) {
    return {
      kind: 'network-unreachable',
      strategy: 'terminal-network-error',
      reason:
        'Terminal blocker: destination is unreachable from the current browser environment.',
      evidence: networkHits,
    };
  }

  const botPatterns: Array<[string, RegExp]> = [
    ['verify-human', /\bverify you are human\b/i],
    ['captcha', /\bcaptcha\b/i],
    ['cloudflare-attention', /\battention required\b/i],
    ['cloudflare-just-a-moment', /\bjust a moment\b/i],
    ['cloudflare-security-verification', /\bperforming security verification\b/i],
    ['cloudflare-secure-connection', /\bchecking if the site connection is secure\b/i],
    ['cloudflare-checking', /\bchecking your browser before accessing\b/i],
    ['cf-challenge', /\bcf[-_ ]challenge\b/i],
    ['turnstile', /\bturnstile\b/i],
  ];
  const botHits = botPatterns.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
  if (botHits.length > 0) {
    return {
      kind: 'bot-challenge',
      strategy: 'terminal-bot-challenge',
      reason:
        'Terminal blocker: anti-bot challenge detected; automated completion is not supported for this flow.',
      evidence: botHits,
    };
  }

  return null;
}

/**
 * Detect persistent app-native environment blockers that are unlikely to be fixed
 * by more navigation attempts inside the same run.
 */
export function detectPersistentTerminalBlocker(
  recentTurns: Turn[],
  currentState: PageState,
): TerminalBlockerDetection | null {
  const appDevEnvPatterns: Array<[string, RegExp]> = [
    ['dev-environment', /\bdev environment\b/i],
    ['orchestrator-offline', /\borchestrator\b.*\boffline\b/i],
    ['websocket-disconnected', /\bwebsocket disconnected\b/i],
    ['event-stream-connecting', /\bevent stream\b.*\bconnecting\b/i],
    ['container-not-started', /\bcontainer\b.*\bnot started\b/i],
    ['not-provisioned', /\bnot provisioned\b/i],
    ['awaiting-provisioning', /\bawaiting provisioning\b/i],
  ];
  if (recentTurns.length < 3) return null;

  const currentSnapshot = currentState.snapshot || '';
  const currentHaystack = `${currentState.url}\n${currentState.title}\n${currentSnapshot}`.toLowerCase();
  const appDevEnvSignals = appDevEnvPatterns
    .filter(([, pattern]) => pattern.test(currentHaystack))
    .map(([name]) => name);
  if (appDevEnvSignals.length < 3) return null;

  const recent = recentTurns.slice(-3);
  const sameUrl = recent.every((turn) => turn.state.url === currentState.url);
  const refreshOrInspectLoop = recent.every((turn) => {
    const action = turn.action;
    return action.action === 'click' || action.action === 'runScript' || action.action === 'wait';
  });
  const repeatedSignals = recent.every((turn) => {
    const haystack = `${turn.state.url}\n${turn.state.title}\n${turn.state.snapshot}`.toLowerCase();
    const matchedSignals = appDevEnvPatterns
      .filter(([, pattern]) => pattern.test(haystack))
      .map(([name]) => name);
    return matchedSignals.length >= 3;
  });

  if (!sameUrl || !refreshOrInspectLoop || !repeatedSignals) return null;

  return {
    kind: 'dev-environment-unavailable',
    strategy: 'terminal-dev-environment-unavailable',
    reason:
      'Terminal blocker: the application dev environment is offline/not provisioned, so preview/start actions cannot complete within this run.',
    evidence: appDevEnvSignals,
  };
}

/**
 * Analyze the current state and return a recovery action if needed.
 * Returns null if no recovery is warranted.
 */
export function analyzeRecovery(ctx: RecoveryContext): RecoveryAction | null {
  const { recentTurns, currentState, consecutiveErrors } = ctx;

  // Strategy 0: Blocker modal/dialog handling — run before stuck detection.
  // Without this, repeated blocked actions often look like generic "stuck".
  const blockingModal = detectBlockingModal(currentState.snapshot);
  if (blockingModal) {
    return {
      strategy: blockingModal.strategy,
      feedback: blockingModal.feedback,
      forceAction: blockingModal.forceAction,
      forceBrowserAction: blockingModal.action,
      waitMs: 500,
    };
  }

  // Strategy 1: Stuck detection — same page for 3+ turns (check BEFORE loading,
  // because a stuck loading state should escalate to reload, not just wait again)
  if (detectStuck(recentTurns, 3)) {
    const lastActions = recentTurns.slice(-3).map((t) => JSON.stringify(t.action));
    const allSame = lastActions.every((a) => a === lastActions[0]);

    // Check for oscillating stuck (menu open/close loop)
    if (recentTurns.length >= 4) {
      const last4 = recentTurns.slice(-4);
      const hashes = last4.map((t) => snapshotHash(t.state.snapshot));
      if (hashes[0] === hashes[2] && hashes[1] === hashes[3] && hashes[0] !== hashes[1]) {
        return {
          strategy: 'stuck-oscillating',
          feedback:
            'STUCK: You are toggling between two states (e.g., opening and closing a menu/dialog) without making progress. ' +
            'The URL has not changed. Stop repeating these actions. ' +
            'Try a completely different approach: use the search box if one is available, navigate directly via URL, ' +
            'or scroll to find alternative navigation elements.',
          forceAction: 'escape',
        };
      }
    }

    // Check for URL cycle (navigating between the same 2-3 pages repeatedly)
    if (recentTurns.length >= 6) {
      const recentUrls = recentTurns.slice(-6).map((t) => t.state.url);
      const is2Cycle = recentUrls[0] === recentUrls[2] && recentUrls[2] === recentUrls[4] &&
        recentUrls[1] === recentUrls[3] && recentUrls[3] === recentUrls[5] && recentUrls[0] !== recentUrls[1];
      const is3Cycle = recentUrls[0] === recentUrls[3] && recentUrls[1] === recentUrls[4] &&
        recentUrls[2] === recentUrls[5] && new Set(recentUrls.slice(0, 3)).size >= 2;
      if (is2Cycle || is3Cycle) {
        return {
          strategy: 'stuck-url-cycle',
          feedback:
            'STUCK: You are navigating in a circle between the same pages without making progress. ' +
            'You have visited the same URLs repeatedly. Stop this loop immediately. ' +
            'The information you need may already be on the current page — look at the ELEMENTS more carefully. ' +
            'If not, try a completely different approach: use a direct URL, extract data with runScript, ' +
            'or look for the answer in the current page content rather than navigating away.',
        };
      }
    }

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
        'If a dialog is present, dismiss or resolve it before retrying.',
    };
  }

  return null;
}
