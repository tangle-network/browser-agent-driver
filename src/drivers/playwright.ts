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
import { CURSOR_OVERLAY_INIT_SCRIPT } from './cursor-overlay.js';
import { runExtractWithIndex, formatExtractWithIndexResult } from './extract-with-index.js';
import { SOM_INJECT_SCRIPT, SOM_REMOVE_SCRIPT } from './som-overlay.js';
import type { SomElement } from './som-overlay.js';

function isPointerInterceptError(error: string): boolean {
  return /intercepts pointer events|subtree intercepts pointer events|not receiving pointer events/i.test(error);
}

// ---------------------------------------------------------------------------
// Mouse humanization — Bezier curve movement with gaussian jitter
// ---------------------------------------------------------------------------

/** Cubic bezier interpolation for a single axis */
function cubicBezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Generate Bezier control points with human-like overshoot */
function bezierControlPoints(
  x0: number, y0: number, x1: number, y1: number,
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  // Control points offset perpendicular to the line + slight overshoot
  const spread = Math.max(30, Math.sqrt(dx * dx + dy * dy) * 0.3);
  const angle = Math.atan2(dy, dx);
  const perpAngle = angle + Math.PI / 2;
  const jitter1 = (Math.random() - 0.5) * spread;
  const jitter2 = (Math.random() - 0.5) * spread;
  return {
    cp1x: x0 + dx * 0.25 + Math.cos(perpAngle) * jitter1,
    cp1y: y0 + dy * 0.25 + Math.sin(perpAngle) * jitter1,
    cp2x: x0 + dx * 0.75 + Math.cos(perpAngle) * jitter2,
    cp2y: y0 + dy * 0.75 + Math.sin(perpAngle) * jitter2,
  };
}

/** Gaussian-distributed click offset — never hits exact center */
function gaussianOffset(size: number): number {
  const sigma = size * 0.15;
  // Box-Muller transform
  const u1 = Math.random() || 0.001;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma;
}

/**
 * Move the real mouse along a Bezier curve from current position to target.
 * Generates 8-15 intermediate points with velocity-based timing (fast in
 * middle, slow at endpoints). Total duration 150-400ms.
 */
async function humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
  // Get current mouse position (approximate from last known or viewport center)
  const viewport = page.viewportSize();
  const startX = viewport ? viewport.width / 2 : 512;
  const startY = viewport ? viewport.height / 2 : 384;

  const { cp1x, cp1y, cp2x, cp2y } = bezierControlPoints(startX, startY, targetX, targetY);
  const steps = 8 + Math.floor(Math.random() * 8); // 8-15 points
  const totalMs = 150 + Math.floor(Math.random() * 250); // 150-400ms

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-in-out timing (slow start/end, fast middle)
    const eased = t < 0.5
      ? 2 * t * t
      : -1 + (4 - 2 * t) * t;
    const x = cubicBezier(eased, startX, cp1x, cp2x, targetX);
    const y = cubicBezier(eased, startY, cp1y, cp2y, targetY);
    await page.mouse.move(x, y);
    if (i < steps) {
      const stepDelay = Math.max(1, Math.floor(totalMs / steps * (0.5 + Math.random())));
      await page.waitForTimeout(stepDelay);
    }
  }
}

// Gen 13: Virtual screen dimensions for vision-first coordinate actions.
// Claude's computer-use training uses 1024x768. Screenshots are resized to
// this before being sent, and coordinate outputs are in this space.
const VIRTUAL_SCREEN = { width: 1024, height: 768 } as const;

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
   *
   * Default: false. Enable for demo recordings, debugging, and the session viewer.
   *
   * **Performance:** zero added wall time. The overlay's CSS transition runs
   * asynchronously alongside the actual click — the cursor in the next
   * screenshot lands wherever the transition has reached by then.
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
  /** Gen 23: SoM element map from last observe — used to resolve clickLabel/typeLabel */
  private somElements: SomElement[] = [];

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

      // Schedule highlight + cursor move + click pulse in a SINGLE page.evaluate
      // round trip. The CSS transition runs asynchronously (no waitForTimeout)
      // — the actual click fires immediately after, and the next observe() picks
      // up the animated cursor in whatever state it has reached.
      //
      // Previously this slept 240ms after the moveTo to let the transition
      // land before the click — pure dead time on every interactive action.
      // Over a 50-turn session that was ~12s of zero-information waiting.
      const isClickLike = actionLabel === 'click' || actionLabel === 'type' || actionLabel === 'press';
      await this.page.evaluate(
        ({ x, y, w, h, label, cx: cxArg, cy: cyArg, pulse }: { x: number; y: number; w: number; h: number; label: string; cx: number; cy: number; pulse: boolean }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ov = (window as any).__bad_overlay;
          if (!ov) return;
          ov.highlightRect(x, y, w, h);
          ov.moveTo(cxArg, cyArg, label);
          if (pulse) ov.pulseClick(cxArg, cyArg);
        },
        { x: box.x, y: box.y, w: box.width, h: box.height, label: actionLabel, cx, cy, pulse: isClickLike },
      ).catch(() => { /* CSP or page closed */ });
    } catch {
      // Overlay is purely cosmetic — never let it break the action
    }
  }

  /**
   * Animate cursor to raw (x, y) coordinates — for clickAt/typeAt actions.
   * Same visual effect as animateCursorToSelector but without needing a locator.
   */
  private async animateCursorToCoord(x: number, y: number, label: string): Promise<void> {
    if (!this.options.showCursor) return;
    if (this.cursorInstallPromise) {
      await this.cursorInstallPromise.catch(() => undefined);
    }
    try {
      await this.page.evaluate(
        ({ cx, cy, lbl }: { cx: number; cy: number; lbl: string }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ov = (window as any).__bad_overlay;
          if (!ov) return;
          ov.moveTo(cx, cy, lbl);
          ov.pulseClick(cx, cy);
        },
        { cx: x, cy: y, lbl: label },
      ).catch(() => {});
    } catch {
      // Cosmetic — never break the action
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

    // Gen 23: SoM overlay — inject numbered labels, screenshot, remove.
    // Only when visionStrategy is 'always' (vision/hybrid mode).
    const useSom = captureScreenshot && this.options.visionStrategy === 'always';
    if (useSom) {
      try {
        this.somElements = await this.page.evaluate(SOM_INJECT_SCRIPT) as SomElement[];
      } catch { this.somElements = []; }
    } else {
      this.somElements = [];
    }

    // Screenshot still via Playwright (viewport compositing)
    const ssStart = performance.now();
    let screenshot: string | undefined;
    if (captureScreenshot) {
      const buf = await this.page.screenshot({ type: 'jpeg', quality });
      screenshot = buf.toString('base64');
    }
    const screenshotMs = performance.now() - ssStart;

    // Remove SoM overlay after screenshot
    if (useSom) {
      await this.page.evaluate(SOM_REMOVE_SCRIPT).catch(() => {});
    }

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
          // Human-like mouse movement to the target before clicking
          if (bounds) {
            const targetX = bounds.x + bounds.width / 2 + gaussianOffset(bounds.width);
            const targetY = bounds.y + bounds.height / 2 + gaussianOffset(bounds.height);
            await humanMouseMove(this.page, targetX, targetY);
          }
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

        case 'extractWithIndex': {
          // Gen 10: numbered DOM-index extraction. Returns the formatted match
          // list as `data` so executePlan can capture it like runScript does.
          // The per-action loop has its own intercept (runner.ts) so this
          // path is only hit when extractWithIndex appears in a planner-
          // emitted Plan step.
          const matches = await runExtractWithIndex(this.page, action.query, action.contains);
          const formatted = formatExtractWithIndexResult(matches, action.query, action.contains);
          return { success: true, error: undefined, data: formatted };
        }

        case 'evaluate':
        case 'verifyPreview':
          // Handled by the runner — the driver just acknowledges it.
          return { success: true };

        case 'complete':
        case 'abort':
          return { success: true };

        case 'fill': {
          // Multi-field batch fill: replaces N×2 turns of click+type with
          // a single turn that fills N fields, selects M dropdowns, and
          // checks K checkboxes. Failures bail with the first error and
          // report which field failed via `error`.
          //
          // Per-field timeout is capped at 5s (vs the default 30s) because
          // batch ops assume every ref was just observed in the snapshot —
          // a missing element should fail FAST, not wait 30s for it to
          // appear. The agent will recover by switching to single-step
          // actions on the next turn.
          const batchFieldTimeout = Math.min(timeout, 5_000);
          const fieldEntries = Object.entries(action.fields ?? {});
          const selectEntries = Object.entries(action.selects ?? {});
          const checkEntries = action.checks ?? [];
          if (fieldEntries.length === 0 && selectEntries.length === 0 && checkEntries.length === 0) {
            return { success: false, error: 'fill action requires at least one of fields/selects/checks' };
          }
          let lastBounds: { x: number; y: number; width: number; height: number } | undefined;
          // Cursor overlay highlights the first non-empty target so the user
          // sees something move on screen. The actual fills happen below.
          const firstSelector = fieldEntries[0]?.[0] ?? selectEntries[0]?.[0] ?? checkEntries[0];
          if (firstSelector) {
            await this.animateCursorToSelector(firstSelector, 'type');
          }
          for (let fi = 0; fi < fieldEntries.length; fi++) {
            const [ref, text] = fieldEntries[fi]!;
            try {
              const locator = this.snapshot.resolveLocator(this.page, ref);
              const bounds = await this.captureBounds(locator);
              if (bounds) lastBounds = bounds;
              await this.withOverlayRecovery(async () => {
                await locator.click({ timeout: batchFieldTimeout });
                await locator.fill(text, { timeout: batchFieldTimeout });
                await locator.evaluate((el) => {
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                });
              });
              // Gen 27: settle delay between fields. Complex forms (Google
              // Flights, Booking) use framework-managed state that needs time
              // to process each field before the next one is filled.
              if (fi < fieldEntries.length - 1) {
                await this.page.waitForTimeout(150);
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { success: false, error: `fill ${ref}: ${message}` };
            }
          }
          for (const [ref, value] of selectEntries) {
            try {
              const locator = this.snapshot.resolveLocator(this.page, ref);
              const bounds = await this.captureBounds(locator);
              if (bounds) lastBounds = bounds;
              await locator.selectOption(value, { timeout: batchFieldTimeout });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { success: false, error: `fill select ${ref}: ${message}` };
            }
          }
          for (const ref of checkEntries) {
            try {
              const locator = this.snapshot.resolveLocator(this.page, ref);
              const bounds = await this.captureBounds(locator);
              if (bounds) lastBounds = bounds;
              await locator.check({ timeout: batchFieldTimeout });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { success: false, error: `fill check ${ref}: ${message}` };
            }
          }
          // Gen 27: post-fill verification. Read back field values to detect
          // silent form resets (e.g., Google Flights wiping fields on state change).
          // Report mismatches so the agent can switch to keyboard-only filling.
          if (fieldEntries.length > 0) {
            await this.page.waitForTimeout(200); // let framework settle
            const mismatches: string[] = [];
            for (const [ref, expectedText] of fieldEntries) {
              try {
                const locator = this.snapshot.resolveLocator(this.page, ref);
                const actualValue = await locator.inputValue({ timeout: 2000 }).catch(() =>
                  locator.evaluate((el: HTMLElement) => {
                    if ('value' in el) return (el as HTMLInputElement).value;
                    return el.textContent?.trim() || '';
                  }).catch(() => '')
                );
                const expected = expectedText.toLowerCase().trim();
                const actual = (actualValue || '').toLowerCase().trim();
                if (actual && expected && !actual.includes(expected) && !expected.includes(actual)) {
                  mismatches.push(`${ref}: expected "${expectedText}" but got "${actualValue}"`);
                }
              } catch { /* skip verification for inaccessible fields */ }
            }
            if (mismatches.length > 0) {
              // Auto-retry mismatched fields with keyboard-mode:
              // click → triple-click (select all) → type → short wait.
              // This fires individual key events that framework components handle
              // better than locator.fill()'s programmatic value assignment.
              const retried: string[] = [];
              for (const mismatch of mismatches) {
                const ref = mismatch.split(':')[0];
                const entry = fieldEntries.find(([r]) => r === ref);
                if (!entry) continue;
                try {
                  const locator = this.snapshot.resolveLocator(this.page, ref);
                  await locator.click({ timeout: 3000 });
                  // Select all existing text
                  await this.page.keyboard.press('Control+a');
                  await this.page.waitForTimeout(50);
                  // Type character-by-character to fire proper key events
                  await this.page.keyboard.type(entry[1], { delay: 30 });
                  await this.page.waitForTimeout(300);
                  retried.push(ref);
                } catch { /* skip failed retries */ }
              }
              const retriedNote = retried.length > 0
                ? ` Auto-retried ${retried.length} field(s) with keyboard input.`
                : '';
              return {
                success: true,
                ...(lastBounds ? { bounds: lastBounds } : {}),
                warning: `FORM RESET DETECTED: ${mismatches.length}/${fieldEntries.length} field(s) did not retain values.${retriedNote} If fields are still wrong, use keyboard-only interaction (click field → type → Enter to confirm autocomplete → Tab to next).`,
              };
            }
          }
          return { success: true, ...(lastBounds ? { bounds: lastBounds } : {}) };
        }

        case 'clickSequence': {
          // Sequential clicks on a known set of refs. For multi-step UI
          // navigation chains where the agent has identified the chain
          // ahead of time. Failures bail on the first error. Same fast-fail
          // 5s per-click cap as batch fill.
          if (action.refs.length === 0) {
            return { success: false, error: 'clickSequence requires at least one ref' };
          }
          const intervalMs = action.intervalMs ?? 100;
          const sequenceClickTimeout = Math.min(timeout, 5_000);
          let lastBounds: { x: number; y: number; width: number; height: number } | undefined;
          for (let i = 0; i < action.refs.length; i++) {
            const ref = action.refs[i];
            try {
              const locator = this.snapshot.resolveLocator(this.page, ref);
              const bounds = await this.captureBounds(locator);
              if (bounds) lastBounds = bounds;
              await this.animateCursorToSelector(ref, 'click');
              await this.withOverlayRecovery(async () => {
                await locator.click({ timeout: sequenceClickTimeout });
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return { success: false, error: `clickSequence step ${i + 1}/${action.refs.length} (${ref}): ${message}` };
            }
            if (i < action.refs.length - 1 && intervalMs > 0) {
              await this.page.waitForTimeout(intervalMs);
            }
          }
          return { success: true, ...(lastBounds ? { bounds: lastBounds } : {}) };
        }

        // Gen 13: Vision-first coordinate-based actions.
        // Bounds use a 40×40 box centered on the click point so the
        // bad-app ClickOverlay renders a visible highlight + ripple.
        case 'clickAt': {
          const viewport = this.page.viewportSize() ?? { width: 1920, height: 1080 };
          const actualX = Math.round(action.x * (viewport.width / VIRTUAL_SCREEN.width));
          const actualY = Math.round(action.y * (viewport.height / VIRTUAL_SCREEN.height));
          await this.animateCursorToCoord(actualX, actualY, 'clickAt');
          await humanMouseMove(this.page, actualX, actualY);
          await this.page.mouse.click(actualX, actualY);
          return { success: true, bounds: { x: actualX - 20, y: actualY - 20, width: 40, height: 40 } };
        }

        case 'typeAt': {
          const viewport = this.page.viewportSize() ?? { width: 1920, height: 1080 };
          const actualX = Math.round(action.x * (viewport.width / VIRTUAL_SCREEN.width));
          const actualY = Math.round(action.y * (viewport.height / VIRTUAL_SCREEN.height));
          await this.animateCursorToCoord(actualX, actualY, 'typeAt');
          await this.page.mouse.click(actualX, actualY);
          await this.page.waitForTimeout(100);
          await this.page.keyboard.type(action.text);
          return { success: true, bounds: { x: actualX - 20, y: actualY - 20, width: 40, height: 40 } };
        }

        // Gen 23: SoM label-based actions — resolve label → element center → click
        case 'clickLabel': {
          const el = this.somElements.find(e => e.label === action.label);
          if (!el) return { success: false, error: `SoM label [${action.label}] not found (${this.somElements.length} elements available)` };
          await this.animateCursorToCoord(el.cx, el.cy, `[${action.label}]`);
          await this.page.mouse.click(el.cx, el.cy);
          return { success: true, bounds: { x: el.x, y: el.y, width: el.width, height: el.height } };
        }

        case 'typeLabel': {
          const el = this.somElements.find(e => e.label === action.label);
          if (!el) return { success: false, error: `SoM label [${action.label}] not found` };
          await this.animateCursorToCoord(el.cx, el.cy, `[${action.label}]`);
          await this.page.mouse.click(el.cx, el.cy);
          await this.page.waitForTimeout(100);
          await this.page.keyboard.type(action.text);
          return { success: true, bounds: { x: el.x, y: el.y, width: el.width, height: el.height } };
        }

        default:
          return { success: false, error: `Unknown action: ${(action as { action: string }).action}` };
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { success: false, error };
    }
  }
}
