/**
 * PlaywrightDriver cursor overlay wiring tests.
 *
 * Regression guard for the critical-audit finding that `--show-cursor`
 * was declared in the CLI but never passed to the driver. These tests
 * exercise the option-flow contract from outside, so a future refactor
 * that breaks the wiring fails loudly here instead of silently in
 * production.
 */

import { describe, it, expect } from 'vitest'
import { chromium } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'

describe('PlaywrightDriver showCursor wiring', () => {
  it('does not throw when constructed with showCursor: true', async () => {
    // The constructor fires `installCursorOverlay()` async; we just verify
    // it doesn't throw synchronously and the driver is usable.
    const browser = await chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto('data:text/html,<button>hello</button>')
      const driver = new PlaywrightDriver(page, { showCursor: true })
      // The overlay install is fire-and-forget but the install promise
      // should be set on the instance so animateCursorToSelector can await it.
      // We can't access the private field directly, but we can verify the
      // overlay actually loaded into the page after a brief settle.
      await page.waitForTimeout(200)
      const installed = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Boolean((window as any).__bad_overlay_installed && (window as any).__bad_overlay)
      })
      expect(installed).toBe(true)
      // The overlay root element exists in the document
      const rootExists = await page.evaluate(() => {
        return !!document.getElementById('__bad_overlay_root')
      })
      expect(rootExists).toBe(true)
      // The highlight box has the stable id (regression guard for the
      // critical-audit children[0] poke)
      const boxExists = await page.evaluate(() => {
        return !!document.getElementById('__bad_overlay_box')
      })
      expect(boxExists).toBe(true)
      void driver
    } finally {
      await browser.close()
    }
  }, 20_000)

  it('does NOT install the overlay when showCursor is false (default)', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto('data:text/html,<button>hello</button>')
      const driver = new PlaywrightDriver(page, {}) // showCursor not set
      await page.waitForTimeout(200)
      const installed = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Boolean((window as any).__bad_overlay_installed)
      })
      expect(installed).toBe(false)
      void driver
    } finally {
      await browser.close()
    }
  }, 20_000)

  it('installs the overlay on a freshly navigated page (init script applies on new docs)', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto('data:text/html,<h1>first</h1>')
      const driver = new PlaywrightDriver(page, { showCursor: true })
      await page.waitForTimeout(200)
      // Navigate to a fresh document — the context-level addInitScript
      // should re-inject on the new doc.
      await page.goto('data:text/html,<h1>second</h1>')
      await page.waitForTimeout(200)
      const installed = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Boolean((window as any).__bad_overlay_installed)
      })
      expect(installed).toBe(true)
      void driver
    } finally {
      await browser.close()
    }
  }, 20_000)
})
