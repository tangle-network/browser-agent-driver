/**
 * Playwright driver — accessibility tree + screenshot observation
 * with ref-based element resolution and full browser action vocabulary.
 *
 * Uses AriaSnapshotHelper for consistent a11y tree snapshots across all drivers.
 * Optionally uses CDP (Chrome DevTools Protocol) for faster observe() calls:
 * - Accessibility.getFullAXTree instead of ariaSnapshot() (no YAML serialize→parse)
 * - Runtime.evaluate for batched page metadata (URL + title + testids in one call)
 * - No 1-second hard sleep (uses lifecycle events only)
 */

import type { Page, CDPSession } from 'playwright';
import type { Driver, ActionResult, ResourceBlockingOptions } from './types.js';
import type { Action, PageState } from '../types.js';
import { AriaSnapshotHelper, dismissOverlays } from './snapshot.js';
import { ANALYTICS_PATTERNS, IMAGE_PATTERNS, MEDIA_PATTERNS } from './block-patterns.js';
import { buildCdpSnapshot } from './cdp-snapshot.js';
import { getPageMetadata } from './cdp-page-state.js';

/** Phase-level timing breakdown for observe() */
export interface ObserveTiming {
  /** Total observe() time in ms */
  totalMs: number;
  /** Time waiting for page load state */
  waitForLoadMs: number;
  /** Time building accessibility tree snapshot */
  snapshotMs: number;
  /** Time getting page metadata (URL, title, testids) */
  metadataMs: number;
  /** Time capturing screenshot (0 if disabled) */
  screenshotMs: number;
  /** Whether CDP fast-path was used */
  usedCdp: boolean;
  /** Size of snapshot in characters */
  snapshotSize: number;
  /** Number of refs in snapshot */
  refCount: number;
}

export interface PlaywrightDriverOptions {
  /** Action timeout in ms */
  timeout?: number;
  /** Capture screenshots on each observe (default: true for vision) */
  captureScreenshots?: boolean;
  /** Screenshot quality (1-100, default 50) */
  screenshotQuality?: number;
  /** Disable CDP fast-path (fall back to Playwright for everything) */
  disableCdp?: boolean;
}

export class PlaywrightDriver implements Driver {
  private snapshot = new AriaSnapshotHelper();
  private cdpSession: CDPSession | null = null;
  private cdpFailed = false;
  private lastTiming: ObserveTiming | undefined;

  constructor(
    private page: Page,
    private options: PlaywrightDriverOptions = {}
  ) {}

  /** Get phase-level timing from the last observe() call */
  getLastTiming(): ObserveTiming | undefined {
    return this.lastTiming;
  }

  getPage(): Page {
    return this.page;
  }

  /**
   * Set up resource blocking to speed up page loads by aborting unnecessary requests.
   * Call before first navigation for best results.
   */
  async setupResourceBlocking(options: ResourceBlockingOptions): Promise<void> {
    const urlPatterns: string[] = [];

    if (options.blockImages) urlPatterns.push(...IMAGE_PATTERNS);
    if (options.blockMedia) urlPatterns.push(...MEDIA_PATTERNS);
    if (options.blockAnalytics) urlPatterns.push(...ANALYTICS_PATTERNS);
    if (options.blockPatterns) urlPatterns.push(...options.blockPatterns);

    if (urlPatterns.length === 0) return;

    const blockImages = options.blockImages ?? false;
    const blockMedia = options.blockMedia ?? false;

    await this.page.route('**/*', async (route) => {
      const url = route.request().url();
      const type = route.request().resourceType();

      // Fast path: check resource type
      if (blockImages && type === 'image') {
        await route.abort();
        return;
      }
      if (blockMedia && type === 'media') {
        await route.abort();
        return;
      }

      // URL pattern matching
      for (const pattern of urlPatterns) {
        if (url.includes(pattern)) {
          await route.abort();
          return;
        }
      }

      await route.continue();
    });
  }

  /**
   * Lazy-init a CDP session. Returns null if CDP is unavailable
   * (non-Chromium browser) or if a previous attempt failed.
   */
  private async ensureCdpSession(): Promise<CDPSession | null> {
    if (this.options.disableCdp || this.cdpFailed) return null;
    if (this.cdpSession) return this.cdpSession;

    try {
      this.cdpSession = await this.page.context().newCDPSession(this.page);
      return this.cdpSession;
    } catch {
      // Non-Chromium browser or CDP not available
      this.cdpFailed = true;
      return null;
    }
  }

  async observe(): Promise<PageState> {
    const observeStart = performance.now();
    const captureScreenshot = this.options.captureScreenshots ?? true;
    const quality = this.options.screenshotQuality ?? 50;

    const waitStart = performance.now();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    const waitForLoadMs = performance.now() - waitStart;

    this.snapshot.reset();

    const cdp = await this.ensureCdpSession();

    if (cdp) {
      try {
        const result = await this.observeCdp(cdp, captureScreenshot, quality);
        this.lastTiming!.waitForLoadMs = waitForLoadMs;
        this.lastTiming!.totalMs = performance.now() - observeStart;
        return result;
      } catch {
        // CDP call failed — detach and fall back to Playwright for this turn
        this.cdpSession = null;
        this.cdpFailed = false; // Allow retry next turn (transient failure)
        this.snapshot.reset(); // Reset refs since CDP partially populated them
      }
    }

    // Fallback: original Playwright path (with 1s sleep)
    const result = await this.observePlaywright(captureScreenshot, quality);
    this.lastTiming!.waitForLoadMs = waitForLoadMs;
    this.lastTiming!.totalMs = performance.now() - observeStart;
    return result;
  }

  /**
   * Fast CDP observation path — no 1s sleep, batched calls.
   */
  private async observeCdp(
    cdp: CDPSession,
    captureScreenshot: boolean,
    quality: number,
  ): Promise<PageState> {
    // Parallel: get page metadata + build AX tree snapshot
    const snapshotStart = performance.now();
    const [metadata, cdpResult] = await Promise.all([
      getPageMetadata(cdp),
      buildCdpSnapshot(cdp),
    ]);
    const snapshotMs = performance.now() - snapshotStart;

    // Import refs into the snapshot helper (for resolveLocator + getDiff)
    this.snapshot.importCdpRefs(cdpResult.refMap, cdpResult.elements);

    // Append testid selectors to snapshot (same as Playwright path)
    let snapshotText = cdpResult.snapshot;
    if (metadata.testIds.length > 0) {
      snapshotText += '\n\nDATA-TESTID SELECTORS (use [data-testid="..."] as selector):';
      for (const el of metadata.testIds) {
        const disabled = el.disabled ? ' [disabled]' : '';
        const text = el.text ? ` "${el.text}"` : '';
        snapshotText += `\n  [data-testid="${el.testId}"] ${el.tag}${text}${disabled}`;
      }
    }

    // Screenshot still via Playwright (viewport compositing)
    const ssStart = performance.now();
    let screenshot: string | undefined;
    if (captureScreenshot) {
      const buf = await this.page.screenshot({ type: 'jpeg', quality });
      screenshot = buf.toString('base64');
    }
    const screenshotMs = performance.now() - ssStart;

    const snapshotDiff = this.snapshot.getDiff();

    this.lastTiming = {
      totalMs: 0, // filled by observe()
      waitForLoadMs: 0, // filled by observe()
      snapshotMs,
      metadataMs: snapshotMs, // metadata fetched in parallel with snapshot
      screenshotMs,
      usedCdp: true,
      snapshotSize: snapshotText.length,
      refCount: cdpResult.refMap.size,
    };

    return {
      url: metadata.url,
      title: metadata.title,
      snapshot: snapshotText,
      screenshot,
      snapshotDiff,
    };
  }

  /**
   * Original Playwright observation path — used as fallback when CDP is unavailable.
   */
  private async observePlaywright(
    captureScreenshot: boolean,
    quality: number,
  ): Promise<PageState> {
    await this.page.waitForTimeout(1000);

    const snapshotStart = performance.now();
    const [url, title, snapshotText] = await Promise.all([
      this.page.url(),
      this.page.title(),
      this.snapshot.buildSnapshot(this.page),
    ]);
    const snapshotMs = performance.now() - snapshotStart;

    const ssStart = performance.now();
    let screenshot: string | undefined;
    if (captureScreenshot) {
      const buf = await this.page.screenshot({ type: 'jpeg', quality });
      screenshot = buf.toString('base64');
    }
    const screenshotMs = performance.now() - ssStart;

    const snapshotDiff = this.snapshot.getDiff();
    const refMatches = snapshotText.match(/\[ref=\w+\]/g);

    this.lastTiming = {
      totalMs: 0, // filled by observe()
      waitForLoadMs: 0, // filled by observe()
      snapshotMs,
      metadataMs: snapshotMs, // metadata fetched in parallel with snapshot
      screenshotMs,
      usedCdp: false,
      snapshotSize: snapshotText.length,
      refCount: refMatches?.length ?? 0,
    };

    return { url, title, snapshot: snapshotText, screenshot, snapshotDiff };
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: this.options.screenshotQuality ?? 70 });
  }

  async close(): Promise<void> {
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
  }

  /**
   * Execute an action first. If it fails and a blocking overlay is detected,
   * dismiss it and retry once.
   */
  private async withOverlayRecovery<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (firstError) {
      const dismissed = await dismissOverlays(this.page);
      if (!dismissed) throw firstError;
      return operation();
    }
  }

  async execute(action: Action): Promise<ActionResult> {
    const timeout = this.options.timeout ?? 30000;

    try {
      switch (action.action) {
        case 'click': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await this.withOverlayRecovery(async () => {
            await locator.click({ timeout });
          });
          return { success: true };
        }

        case 'type': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await this.withOverlayRecovery(async () => {
            await locator.click({ timeout });
            await locator.fill(action.text, { timeout });
            await locator.evaluate((el) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
          });
          return { success: true };
        }

        case 'press': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await this.withOverlayRecovery(async () => {
            await locator.press(action.key, { timeout });
          });
          return { success: true };
        }

        case 'hover': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await locator.hover({ timeout });
          return { success: true };
        }

        case 'select': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await locator.selectOption(action.value, { timeout });
          return { success: true };
        }

        case 'scroll': {
          const delta = action.direction === 'down'
            ? (action.amount ?? 500)
            : -(action.amount ?? 500);
          if (action.selector) {
            // Scroll a specific container element
            const container = this.snapshot.resolveLocator(this.page, action.selector);
            await container.evaluate((el, d) => { el.scrollBy(0, d); }, delta);
          } else {
            await this.page.mouse.wheel(0, delta);
          }
          return { success: true };
        }

        case 'navigate':
          await this.page.goto(action.url, { timeout });
          return { success: true };

        case 'wait':
          await this.page.waitForTimeout(action.ms);
          return { success: true };

        case 'runScript': {
          const scriptResult = await this.page.evaluate(action.script);
          const stringified = typeof scriptResult === 'string'
            ? scriptResult
            : JSON.stringify(scriptResult, null, 2);
          return { success: true, error: undefined, data: stringified };
        }

        case 'evaluate':
        case 'verifyPreview':
          // Handled by the runner — the driver just acknowledges it.
          return { success: true };

        case 'complete':
        case 'abort':
          return { success: true };

        default:
          return { success: false, error: `Unknown action: ${(action as { action: string }).action}` };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
