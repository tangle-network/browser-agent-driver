/**
 * Playwright driver — accessibility tree + screenshot observation
 * with ref-based element resolution and full browser action vocabulary.
 *
 * Uses AriaSnapshotHelper for consistent a11y tree snapshots across all drivers.
 */

import type { Page } from 'playwright';
import type { Driver, ActionResult, ResourceBlockingOptions } from './types.js';
import type { Action, PageState } from '../types.js';
import { AriaSnapshotHelper, dismissOverlays } from './snapshot.js';
import { ANALYTICS_PATTERNS, IMAGE_PATTERNS, MEDIA_PATTERNS } from './block-patterns.js';

export interface PlaywrightDriverOptions {
  /** Action timeout in ms */
  timeout?: number;
  /** Capture screenshots on each observe (default: true for vision) */
  captureScreenshots?: boolean;
  /** Screenshot quality (1-100, default 50) */
  screenshotQuality?: number;
}

export class PlaywrightDriver implements Driver {
  private snapshot = new AriaSnapshotHelper();

  constructor(
    private page: Page,
    private options: PlaywrightDriverOptions = {}
  ) {}

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

  async observe(): Promise<PageState> {
    // Default to capturing screenshots (needed for vision-enabled Brain)
    const captureScreenshot = this.options.captureScreenshots ?? true;
    const quality = this.options.screenshotQuality ?? 50;

    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForTimeout(1000);

    this.snapshot.reset();

    const [url, title, snapshotText] = await Promise.all([
      this.page.url(),
      this.page.title(),
      this.snapshot.buildSnapshot(this.page),
    ]);

    let screenshot: string | undefined;
    if (captureScreenshot) {
      const buf = await this.page.screenshot({ type: 'jpeg', quality });
      screenshot = buf.toString('base64');
    }

    const snapshotDiff = this.snapshot.getDiff();

    return { url, title, snapshot: snapshotText, screenshot, snapshotDiff };
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot({ type: 'jpeg', quality: this.options.screenshotQuality ?? 70 });
  }

  async execute(action: Action): Promise<ActionResult> {
    const timeout = this.options.timeout ?? 30000;

    if (action.action === 'click' || action.action === 'type' || action.action === 'press') {
      await dismissOverlays(this.page);
    }

    try {
      switch (action.action) {
        case 'click': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await locator.click({ timeout });
          return { success: true };
        }

        case 'type': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await locator.click({ timeout });
          await locator.fill(action.text, { timeout });
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
          return { success: true };
        }

        case 'press': {
          const locator = this.snapshot.resolveLocator(this.page, action.selector);
          await locator.press(action.key, { timeout });
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
