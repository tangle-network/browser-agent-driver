/**
 * Per-action effect verification: the helper the runner loop calls after each
 * executed action to decide whether the expected effect actually landed.
 *
 * Extracted from runner.ts via the delegate + host-interface pattern. The
 * BrowserAgent class keeps a thin delegator (`verifyEffect`); this free
 * function holds the method body verbatim and reads runner state through
 * {@link RunnerEffectVerifyHost}, which BrowserAgent `implements` so tsc proves
 * the host surface is complete. Behavior is byte-identical to the inlined
 * version — same settle-wait conditions, timing, and verifier call.
 */

import type { Driver } from '../drivers/types.js';
import type { Action, PageState } from '../types.js';

import { verifyExpectedEffect } from './effect-verification.js';

/**
 * The slice of runner state the effect verifier reads. The BrowserAgent class
 * declares `implements RunnerEffectVerifyHost`, so a missing or mistyped member
 * is a compile error — this interface IS the safety gate for the extraction.
 * All members are public on BrowserAgent by construction.
 */
export interface RunnerEffectVerifyHost {
  driver: Driver;
  cachedPostState: PageState | undefined;
}

export async function verifyEffectImpl(
  self: RunnerEffectVerifyHost,
  expectedEffect: string,
  preActionState: PageState,
  actionType?: Action['action'],
): Promise<{ verified: boolean; reason?: string }> {
  // Only pause for actions that mutate the page in flight (navigation,
  // clicks that may trigger XHR/route transitions, form submits). For
  // pure reads, scrolls, hovers, and waits the page state is already
  // settled by the time execute returns. The previous unconditional
  // 100ms wait was pure dead time on every turn.
  const needsSettleWait = actionType === 'click'
    || actionType === 'navigate'
    || actionType === 'press'
    || actionType === 'select';
  // Kick observe off immediately and let the settle wait race against it.
  // observe() polls waitForLoadState internally, so the 50ms settle is
  // really only there to let click handlers schedule their first XHR; we
  // don't need to *block* on it before starting observe.
  const observePromise = self.driver.observe().catch(() => preActionState);
  if (needsSettleWait) {
    await Promise.all([
      observePromise,
      new Promise(r => setTimeout(r, 50)),
    ]);
  }
  const postState = await observePromise;
  self.cachedPostState = postState;
  return verifyExpectedEffect({
    expectedEffect,
    preActionState,
    postActionState: postState,
  });
}
