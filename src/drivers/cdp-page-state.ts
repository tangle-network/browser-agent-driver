/**
 * CDP-based batched page metadata retrieval.
 *
 * Replaces 3 separate Playwright calls (page.url(), page.title(),
 * page.evaluate(testids)) with a single Runtime.evaluate via CDP.
 */

import type { CDPSession } from 'playwright';

export interface PageMetadata {
  url: string;
  title: string;
  testIds: Array<{
    testId: string;
    tag: string;
    text: string;
    disabled: boolean;
  }>;
}

/**
 * Get page URL, title, and data-testid elements in a single CDP call.
 */
export async function getPageMetadata(cdp: CDPSession): Promise<PageMetadata> {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const INTERACTIVE = new Set(['button', 'input', 'textarea', 'select', 'a']);
      const elements = document.querySelectorAll('[data-testid]');
      const testIds = Array.from(elements)
        .filter(el => INTERACTIVE.has(el.tagName.toLowerCase()) || el.getAttribute('role'))
        .slice(0, 30)
        .map(el => ({
          testId: el.getAttribute('data-testid') || '',
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          disabled: el.disabled || false,
        }));
      return JSON.stringify({
        url: location.href,
        title: document.title,
        testIds,
      });
    })()`,
    returnByValue: true,
  });

  if (result.type === 'string') {
    return JSON.parse(result.value as string) as PageMetadata;
  }

  // Fallback if evaluate returns unexpected format
  return { url: '', title: '', testIds: [] };
}
