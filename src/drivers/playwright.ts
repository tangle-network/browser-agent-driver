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
import { CURSOR_OVERLAY_INIT_SCRIPT, CURSOR_ANIMATION_MS } from './cursor-overlay.js';

function isPointerInterceptError(error: string): boolean {
  return /intercepts pointer events|subtree intercepts pointer events|not receiving pointer events/i.test(error);
}

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
  /** Vision strategy — controls when screenshots are sent to the LLM */
  visionStrategy?: 'always' | 'never' | 'auto';
  /** Capture a screenshot every N turns for artifact storage (0 = disabled) */
  screenshotInterval?: number;
  /**
   * Inject a cursor + element-highlight overlay so screenshots show what bad
   * is doing. Adds an animated cursor sprite that travels to click targets,
   * pulse rings on click, and highlight boxes around the target element.
   * Default: false. Enable for demo recordings, debugging, and the session viewer.
   */
  showCursor?: boolean;
}

export class PlaywrightDriver implements Driver {
  private snapshot = new AriaSnapshotHelper();
  private cdpSession: CDPSession | null = null;
  private cdpFailed = false;
  private lastTiming: ObserveTiming | undefined;
  private observeCount = 0;
  /**
   * Promise that resolves when the cursor overlay finishes installing.
   * `animateCursorToSelector` awaits this so the first action doesn't race
   * the init script. Undefined if showCursor is off.
   */
  private cursorInstallPromise?: Promise<void>;

  constructor(
    private page: Page,
    private options: PlaywrightDriverOptions = {}
  ) {
    if (this.options.showCursor) {
      // Install for the current page AND any future pages this context creates.
      // We store the promise so callers (animateCursorToSelector) can await it
      // before driving the overlay — otherwise the first action races the inject.
      this.cursorInstallPromise = this.installCursorOverlay()
    }
  }

  /**
   * Inject the cursor overlay init script into the current page and into the
   * browser context, so it survives navigations and applies to popups.
   */
  private async installCursorOverlay(): Promise<void> {
    try {
      // Context-level: applies to all current and future pages
      await this.page.context().addInitScript({ content: CURSOR_OVERLAY_INIT_SCRIPT });
      // Page-level: ensure the current page has it now (addInitScript is for new docs)
      await this.page.evaluate(CURSOR_OVERLAY_INIT_SCRIPT).catch(() => { /* may already exist or CSP-blocked */ });
    } catch {
      // Strict CSP can block evaluate; init script via context still works on next nav
    }
  }

  /**
   * Animate the cursor to the target element + draw a highlight box, then
   * pulse a click ring. No-op if showCursor is disabled.
   *
   * Uses Playwright's boundingBox to compute the rect (works for any locator,
   * including @ref selectors that don't map to plain CSS) and drives the
   * overlay via its public `highlightRect` / `moveTo` / `pulseClick` API.
   */
  private async animateCursorToSelector(
    selector: string,
    actionLabel: string,
  ): Promise<void> {
    if (!this.options.showCursor) return;
    // Make sure the install promise (fired in the constructor) has resolved
    // before we try to drive the overlay. Otherwise the first action races
    // the script injection and the cursor never appears.
    if (this.cursorInstallPromise) {
      await this.cursorInstallPromise.catch(() => undefined);
    }
    try {
      const locator = this.snapshot.resolveLocator(this.page, selector);
      const box = await locator.boundingBox({ timeout: 1000 }).catch(() => null);
      if (!box) return;

      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      await this.page.evaluate(
        ({ x, y, w, h, label, cx: cxArg, cy: cyArg }: { x: number; y: number; w: number; h: number; label: string; cx: number; cy: number }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ov = (window as any).__bad_overlay;
          if (!ov) return;
          ov.highlightRect(x, y, w, h);
          ov.moveTo(cxArg, cyArg, label);
        },
        { x: box.x, y: box.y, w: box.width, h: box.height, label: actionLabel, cx, cy },
      ).catch(() => { /* CSP or page closed */ });

      await this.page.waitForTimeout(CURSOR_ANIMATION_MS);

      if (actionLabel === 'click' || actionLabel === 'type' || actionLabel === 'press') {
        await this.page.evaluate(
          ({ x, y }: { x: number; y: number }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ov = (window as any).__bad_overlay;
            if (ov) ov.pulseClick(x, y);
          },
          { x: cx, y: cy },
        ).catch(() => { /* CSP */ });
      }
    } catch {
      // Overlay is purely cosmetic — never let it break the action
    }
  }

  /** Get phase-level timing from the last observe() call */
  getLastTiming(): ObserveTiming | undefined {
    return this.lastTiming;
  }

  getPage(): Page {
    return this.page;
  }

  getUrl(): string {
    return this.page.url();
  }

  async inspectSelectorHref(selector: string): Promise<string | undefined> {
    const locator = this.snapshot.resolveLocator(this.page, selector);
    return locator.evaluate((node) => {
      const element = node as Element | null;
      const anchor = element?.closest('a[href]') as HTMLAnchorElement | null;
      return anchor?.href || undefined;
    }).catch(() => undefined);
  }

  private async adoptPage(nextPage: Page): Promise<void> {
    if (this.page === nextPage) return;
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
    }
    this.page = nextPage;
    this.cdpSession = null;
    this.cdpFailed = false;
    this.snapshot.reset();
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
    this.observeCount++;
    const quality = this.options.screenshotQuality ?? 50;

    // Only capture screenshots when they'll actually be used:
    // - visionStrategy 'always': brain will consume every screenshot
    // - screenshotInterval: artifact sink needs a screenshot on matching turns
    // For 'auto'/'never', skip the JPEG encode (~50-150ms). The runner's
    // attachDecisionScreenshot() captures on-demand when escalation fires.
    const wantedForVision = (this.options.captureScreenshots ?? true)
      && this.options.visionStrategy === 'always';
    const interval = this.options.screenshotInterval ?? 0;
    const wantedForArtifact = interval > 0 && this.observeCount % interval === 0;
    const captureScreenshot = wantedForVision || wantedForArtifact;

    const waitStart = performance.now();
    // Cap load state wait at 5s — heavy JS sites (AliExpress) can stall
    // domcontentloaded for 30s+. The page usually has usable DOM much earlier.
    // ~70% of pages load in <2s, so 5s captures nearly all legitimate loads.
    await Promise.race([
      this.page.waitForLoadState('domcontentloaded').catch(() => {}),
      new Promise<void>(resolve => setTimeout(resolve, 5_000)),
    ]);
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
    const snapshotDiffRaw = this.snapshot.getRawDiff();

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
      snapshotDiffRaw,
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
    const snapshotDiffRaw = this.snapshot.getRawDiff();
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

    return { url, title, snapshot: snapshotText, screenshot, snapshotDiff, snapshotDiffRaw };
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

  private async captureBounds(locator: import('playwright').Locator): Promise<ActionResult['bounds']> {
    try {
      const box = await locator.boundingBox({ timeout: 2000 });
      if (box) return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    } catch {
      // Element may be gone after navigation — non-critical
    }
    return undefined;
  }

  async execute(action: Action): Promise<ActionResult> {
    const timeout = this.options.timeout ?? 30000;

    try {
      switch (action.action) {
        case 'click': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          const bounds = await this.captureBounds(locator);
          await this.animateCursorToSelector(action.selector, 'click');
          // Listen for popups but don't block: collect any that fire during the click
          let popupPage: import('playwright').Page | null = null;
          const onPopup = (page: import('playwright').Page) => { popupPage = page; };
          this.page.context().on('page', onPopup);
          try {
            await this.withOverlayRecovery(async () => {
              await locator.click({ timeout });
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!isPointerInterceptError(message)) throw err;
            await locator.click({ timeout, force: true });
          }
          this.page.context().off('page', onPopup);
          // If a popup opened during the click, adopt it immediately (no waiting)
          if (!popupPage) {
            // Brief grace period for popups that fire after click resolves
            popupPage = await this.page.context()
              .waitForEvent('page', { timeout: 200 })
              .catch(() => null);
          }
          if (popupPage && !popupPage.isClosed()) {
            await popupPage.waitForLoadState('domcontentloaded').catch(() => {});
            await this.adoptPage(popupPage);
          }
          return { success: true, bounds };
        }

        case 'type': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          const bounds = await this.captureBounds(locator);
          await this.animateCursorToSelector(action.selector, 'type');
          try {
            await this.withOverlayRecovery(async () => {
              await locator.click({ timeout });
              await locator.fill(action.text, { timeout });
              await locator.evaluate((el) => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              });
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!isPointerInterceptError(message)) throw err;
            await locator.click({ timeout, force: true });
            await locator.fill(action.text, { timeout });
            await locator.evaluate((el) => {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
          }
          return { success: true, bounds };
        }

        case 'press': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          const bounds = await this.captureBounds(locator);
          await this.animateCursorToSelector(action.selector, 'press');
          await this.withOverlayRecovery(async () => {
            await locator.press(action.key, { timeout });
          });
          return { success: true, bounds };
        }

        case 'hover': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          const bounds = await this.captureBounds(locator);
          await this.animateCursorToSelector(action.selector, 'hover');
          await locator.hover({ timeout });
          return { success: true, bounds };
        }

        case 'select': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          const bounds = await this.captureBounds(locator);
          await this.animateCursorToSelector(action.selector, 'select');
          await locator.selectOption(action.value, { timeout });
          return { success: true, bounds };
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

        case 'navigate': {
          // Cap navigation at 15s — heavy JS sites (AliExpress, etc.) can stall domcontentloaded
          // for 40s+. Better to proceed with partial DOM than timeout the whole case.
          const navTimeout = Math.min(timeout, 15_000);
          try {
            await this.page.goto(action.url, { timeout: navTimeout, waitUntil: 'domcontentloaded' });
          } catch (navErr) {
            // If domcontentloaded timed out but the page has started loading,
            // proceed — the agent can still interact with whatever is in the DOM.
            const currentUrl = this.page.url();
            if (currentUrl !== 'about:blank' && currentUrl !== '') {
              // Page partially loaded — continue with what we have
              return { success: true };
            }
            throw navErr;
          }
          return { success: true };
        }

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
