/**
 * Regression: turn-1 observe() must never hang on a wedged CDP call.
 *
 * Incident (adc #3589): a raw CDPSession.send() (Accessibility.getFullAXTree /
 * Runtime.evaluate) carries no Playwright timeout, so behind a managed-egress
 * proxy on about:blank the call never returned and observe() hung for the whole
 * 600s case budget. observe() now bounds each CDP call and degrades
 * CDP -> Playwright -> minimal state. These tests fail (hang) on the pre-fix code.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  PlaywrightDriver,
  withObserveTimeout,
  ObserveTimeoutError,
} from '../src/drivers/playwright.js';

describe('withObserveTimeout', () => {
  it('passes a value through when it settles in time', async () => {
    await expect(withObserveTimeout(Promise.resolve('ok'), 'step', 1_000)).resolves.toBe('ok');
  });

  it('rejects with a labeled ObserveTimeoutError when the promise hangs', async () => {
    const never = new Promise<never>(() => {});
    const err = await withObserveTimeout(never, 'Accessibility.getFullAXTree', 20).catch((e) => e);
    expect(err).toBeInstanceOf(ObserveTimeoutError);
    expect(err.step).toBe('Accessibility.getFullAXTree');
    expect(err.timeoutMs).toBe(20);
    expect(String(err.message)).toContain('Accessibility.getFullAXTree');
  });

  it('propagates the original rejection instead of wrapping non-timeout errors', async () => {
    const boom = new Error('cdp exploded');
    await expect(withObserveTimeout(Promise.reject(boom), 'step', 1_000)).rejects.toBe(boom);
  });
});

describe('PlaywrightDriver.observe() degradation on a wedged renderer', () => {
  let browser: Browser;
  let context: BrowserContext;

  const HTML =
    '<!doctype html><html><body><h1>Observe Timeout Test</h1>' +
    '<button data-testid="go">Go</button></body></html>';

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await context?.close();
  });

  async function newPage(): Promise<Page> {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(HTML);
    return page;
  }

  /** Force Accessibility.getFullAXTree to hang while Runtime.evaluate returns a
   * valid metadata result instantly — the exact shape of the #3589 wedge, and
   * deterministic: only getFullAXTree ever trips the timeout, so the fallback
   * warning always names it regardless of CI load. */
  function wedgeAxTree(page: Page): void {
    const ctx = page.context();
    const realNewSession = ctx.newCDPSession.bind(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(ctx, 'newCDPSession').mockImplementation(async (target: any) => {
      const session = await realNewSession(target);
      vi.spyOn(session, 'send').mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((method: string) => {
          if (method === 'Accessibility.getFullAXTree') return new Promise(() => {}); // the wedge
          if (method === 'Runtime.evaluate') {
            return Promise.resolve({
              result: {
                type: 'string',
                value: JSON.stringify({ url: 'about:blank', title: '', testIds: [] }),
              },
            });
          }
          return Promise.resolve({});
        }) as any,
      );
      return session;
    });
  }

  it('falls back to the Playwright path (real snapshot) when a CDP call hangs', async () => {
    const page = await newPage();
    wedgeAxTree(page);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const driver = new PlaywrightDriver(page, { showCursor: false, cdpObserveTimeoutMs: 300 });
    const started = Date.now();
    const state = await driver.observe();
    const elapsed = Date.now() - started;

    // Did not hang, and produced a real snapshot via the Playwright fallback.
    expect(elapsed).toBeLessThan(8_000);
    expect(state.snapshot).not.toContain('observation timed out');
    expect(state.snapshot).toContain('Observe Timeout Test');
    expect(driver.getLastTiming()?.usedCdp).toBe(false);
    // Logged which CDP step wedged (this is how #3589 gets localized from prod logs).
    expect(warn.mock.calls.flat().join(' ')).toContain('Accessibility.getFullAXTree');
  });

  it('returns a minimal state (not a hang) when the whole observe budget is exceeded', async () => {
    const page = await newPage();
    // Skip CDP and force the whole observe budget to expire (observePlaywright's 1s
    // pre-sleep alone exceeds the 10ms budget) so observe() must return degraded.
    const driver = new PlaywrightDriver(page, {
      showCursor: false,
      disableCdp: true,
      observeBudgetMs: 10,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const started = Date.now();
    const state = await driver.observe();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    expect(state.snapshot).toContain('observation timed out');
    expect(state.url).toBeTruthy();
    expect(driver.getLastTiming()?.usedCdp).toBe(false);
  });
});
