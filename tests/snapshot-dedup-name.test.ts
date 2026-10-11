/**
 * Wave-3 date-widget fix: @refs whose snapshot name is a doubled
 * accessible name ('Month Month' — the aria-label + labelledby
 * concatenation artifact) resolve to a working locator via the deduped
 * name. Before the fix, every action on such a ref timed out waiting for
 * getByRole('<doubled>', exact) — the wave-2 form-fill date loop burned
 * 12 turns on exactly this.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { AriaSnapshotHelper } from '../src/drivers/snapshot.js'

const HTML = `
<!DOCTYPE html>
<html><body>
  <label for="dob">Date of Birth</label>
  <input id="dob" type="date" data-testid="dob" />
  <label for="qty">Quantity</label>
  <input id="qty" type="number" aria-label="Month" />
</body></html>
`

describe('AriaSnapshotHelper ref resolution with doubled accessible names', () => {
  let browser: Browser
  let page: Page
  let helper: AriaSnapshotHelper

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(HTML)
    helper = new AriaSnapshotHelper()
    // Seed the ref map the way the wave-2 bench snapshot looked: the
    // number input's computed name is 'Month', but the a11y tree reported
    // 'Month Month'.
    helper.importCdpRefs(
      new Map([['s225b', { role: 'spinbutton', name: 'Month Month' }]]),
      new Map(),
    )
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('resolves a doubled-name ref to the real element via the deduped name', async () => {
    const locator = helper.resolveLocator(page, '@s225b')
    await expect(locator.count()).resolves.toBe(1)
    await expect(locator.first().getAttribute('id')).resolves.toBe('qty')
  })

  it('the doubled name alone finds nothing (proves the fallback is load-bearing)', async () => {
    await expect(
      page.getByRole('spinbutton', { name: 'Month Month', exact: true }).count(),
    ).resolves.toBe(0)
  })

  it('still resolves and fills a date textbox with YYYY-MM-DD (the preferred date path)', async () => {
    const dob = page.locator('#dob')
    await dob.fill('1990-04-15')
    await expect(dob.inputValue()).resolves.toBe('1990-04-15')
  })
})
