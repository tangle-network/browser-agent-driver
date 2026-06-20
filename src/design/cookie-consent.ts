import type { Page } from 'playwright'

/**
 * Canonical cookie/consent banner dismissal for the design-capture paths (token
 * extraction + the audit pipeline). Clicks the first visible match and returns —
 * a banner is one decision, not a sweep. Best-effort: every step is guarded, so a
 * missing/odd banner never throws into the capture flow. (page-interaction's
 * `dismissModals` is a separate, richer concern — cookie banners plus generic
 * modals + stats — and deliberately keeps its own logic.)
 */
const COOKIE_BANNER_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept")',
  'button:has-text("Reject all")',
  'button:has-text("Got it")',
  'button:has-text("Close")',
] as const

export async function dismissCookieBanners(page: Page): Promise<void> {
  for (const sel of COOKIE_BANNER_SELECTORS) {
    const btn = page.locator(sel).first()
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => null)
      await page.waitForTimeout(500)
      return
    }
  }
}
