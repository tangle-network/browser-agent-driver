/**
 * Regression test for the type action's removed pre-fill click.
 *
 * The old sequence (click, then fill) hung to the full actionability
 * timeout on elements whose hit target is obstructed — e.g. the bench
 * fixture's date input — even though fill() itself succeeds instantly
 * (fill checks visible/enabled/editable, not the hit target). On the
 * bench corpus this cost ~225s of wall time in 30s click timeouts.
 *
 * This page's input has pointer-events:none: click() can never pass its
 * hit-target check and throws after the (2s, test-sized) timeout, while
 * fill() succeeds. With the pre-fill click restored this test fails with
 * a TimeoutError; with fill-only it passes in milliseconds.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'

const HTML = `
<!DOCTYPE html>
<html><body>
  <input id="ghost" data-testid="ghost" type="text" style="pointer-events:none" />
  <input id="dob" data-testid="dob" type="date" />
</body></html>
`

describe('PlaywrightDriver type action (no pre-fill click)', () => {
  let browser: Browser
  let page: Page
  let driver: PlaywrightDriver

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(HTML)
    driver = new PlaywrightDriver(page, { showCursor: false, timeout: 2000 })
    await driver.observe()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('types into an input whose hit target is obstructed, fast', async () => {
    const started = Date.now()
    const result = await driver.execute({
      action: 'type',
      selector: '[data-testid="ghost"]',
      text: 'no click needed',
    })
    expect(result.success).toBe(true)
    expect(await page.inputValue('[data-testid="ghost"]')).toBe('no click needed')
    // A pre-fill click would burn the full 2s test timeout before failing.
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('still types into a normal date input', async () => {
    const result = await driver.execute({
      action: 'type',
      selector: '[data-testid="dob"]',
      text: '1990-04-15',
    })
    expect(result.success).toBe(true)
    expect(await page.inputValue('[data-testid="dob"]')).toBe('1990-04-15')
  })
})
