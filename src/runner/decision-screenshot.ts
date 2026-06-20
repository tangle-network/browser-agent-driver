/**
 * Decision-time screenshot attachment: lazily captures a base64 screenshot and
 * folds it into the PageState when vision is requested for a decide/scout turn.
 *
 * Extracted from runner.ts via the delegate + host-interface pattern. The
 * BrowserAgent class keeps a thin delegator (`attachDecisionScreenshot`); this
 * free function holds the method body verbatim and reads runner state through
 * {@link RunnerDecisionScreenshotHost}, which BrowserAgent `implements` so tsc
 * proves the host surface is complete. Behavior is byte-identical to the
 * inlined version.
 */

import type { Driver } from '../drivers/types.js';
import type { PageState } from '../types.js';

/**
 * The slice of runner state attachDecisionScreenshot reads. The BrowserAgent
 * class declares `implements RunnerDecisionScreenshotHost`, so a missing or
 * mistyped member is a compile error — this interface IS the safety gate for
 * the extraction.
 */
export interface RunnerDecisionScreenshotHost {
  driver: Driver;
}

export async function attachDecisionScreenshotImpl(
  self: RunnerDecisionScreenshotHost,
  state: PageState,
): Promise<PageState> {
  if (state.screenshot || !self.driver.screenshot) return state;
  try {
    const screenshot = await self.driver.screenshot();
    return { ...state, screenshot: screenshot.toString('base64') };
  } catch {
    return state;
  }
}
