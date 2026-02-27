/**
 * Preview App Verification — navigate outside the sandbox iframe
 * to verify the generated app actually works.
 *
 * The preview is rendered in an iframe (title="Preview") that has
 * sandbox restrictions. This utility extracts the preview URL,
 * navigates Playwright directly to it, captures the a11y tree + screenshot,
 * and checks for errors.
 */

import type { Page } from 'playwright';
import { AriaSnapshotHelper } from './drivers/snapshot.js';
import type { PreviewVerification } from './types.js';

/**
 * Extract the preview iframe URL from the current page.
 * Returns null if no preview iframe is found.
 */
async function extractPreviewUrl(page: Page, customSelector?: string): Promise<string | null> {
  const sel = customSelector;
  return page.evaluate(([selector]: [string | undefined]) => {
    // Try custom selector first, then default pattern
    if (selector) {
      const el = document.querySelector(selector) as HTMLIFrameElement | null;
      if (el?.src) return el.src;
    }

    // Look for iframe with title="Preview" (bolt/blueprint pattern)
    const iframe = document.querySelector('iframe[title="Preview"]') as HTMLIFrameElement | null;
    if (iframe?.src) return iframe.src;

    // Fallback: any iframe with a src URL (works for any embedded app)
    const iframes = document.querySelectorAll('iframe[src]');
    for (const f of iframes) {
      const src = (f as HTMLIFrameElement).src;
      if (src && !src.startsWith('about:') && !src.startsWith('javascript:')) return src;
    }

    return null;
  }, [sel] as [string | undefined]);
}

/**
 * Verify the preview app by navigating directly to the preview URL.
 *
 * Steps:
 * 1. Extract preview URL from the iframe
 * 2. Navigate Playwright to the preview URL (bypasses sandbox)
 * 3. Capture a11y tree + screenshot + errors
 * 4. Navigate back to the original page
 *
 * Returns null if no preview iframe is found.
 */
export async function verifyPreview(
  page: Page,
  snapshot: AriaSnapshotHelper,
  options?: {
    captureScreenshot?: boolean;
    screenshotQuality?: number;
    /** Explicit preview URL — skips iframe extraction */
    previewUrl?: string;
    /** Custom iframe selector (default: 'iframe[title="Preview"]') */
    iframeSelector?: string;
  }
): Promise<PreviewVerification | null> {
  const previewUrl = options?.previewUrl ?? await extractPreviewUrl(page, options?.iframeSelector);
  if (!previewUrl) return null;

  const originalUrl = page.url();

  try {
    // Navigate directly to the preview app
    await page.goto(previewUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });

    // Wait for page to fully load, then brief settle delay
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);

    const title = await page.title();

    // Capture a11y tree
    snapshot.reset();
    const snapshotText = await snapshot.buildSnapshot(page);

    // Check for visible errors
    const errors = await page.evaluate(() => {
      const found: string[] = [];

      /** Check if element is rendered (handles position:fixed where offsetParent is null) */
      function isVisible(el: HTMLElement): boolean {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      // Check for standard error indicators
      const errorSelectors = ['[role="alert"]', 'pre.error'];
      for (const sel of errorSelectors) {
        const el = document.querySelector(sel);
        if (el && el instanceof HTMLElement && isVisible(el)) {
          const text = (el.textContent || '').trim().slice(0, 200);
          if (text) found.push(text);
        }
      }

      // Vite error overlay uses a custom element with Shadow DOM —
      // textContent is empty, so just detect its presence
      const viteOverlay = document.querySelector('vite-error-overlay');
      if (viteOverlay) {
        // Try to read from shadow root if open
        const shadowText = viteOverlay.shadowRoot?.querySelector('.message')?.textContent?.trim();
        found.push(shadowText?.slice(0, 200) || 'Vite error overlay detected');
      }

      // Check for blank page — exclude script-only pages (SPA shells before hydration)
      const body = document.body;
      if (body) {
        const hasVisibleChildren = Array.from(body.children).some(
          (child) => child.tagName !== 'SCRIPT' && child.tagName !== 'LINK' &&
            child instanceof HTMLElement && isVisible(child)
        );
        if (!hasVisibleChildren && body.innerText.trim().length === 0) {
          found.push('Page appears blank — no visible content rendered');
        }
      }

      return found;
    });

    // Capture screenshot if requested
    let screenshot: string | undefined;
    if (options?.captureScreenshot !== false) {
      const quality = options?.screenshotQuality ?? 50;
      const buf = await page.screenshot({ type: 'jpeg', quality });
      screenshot = buf.toString('base64');
    }

    const appLoaded = errors.length === 0 && snapshotText !== '(empty page)';

    const result: PreviewVerification = {
      previewUrl,
      appLoaded,
      title,
      snapshot: snapshotText,
      screenshot,
      errors,
    };

    // Navigate back to the original page
    try {
      await page.goto(originalUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
    } catch {
      // If nav-back fails, report it as an error so the agent knows
      result.errors.push(`Failed to navigate back to ${originalUrl} — page may be on the preview URL`);
    }

    return result;
  } catch (err) {
    // If preview navigation itself fails, return a failed result
    return {
      previewUrl,
      appLoaded: false,
      title: '',
      snapshot: '(preview navigation failed)',
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
