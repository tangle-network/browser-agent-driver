/**
 * Wave-3 date-control root fix: Chrome's date control appears in the aria
 * snapshot as a `Date` group whose shadow spinbuttons ('Month Month' etc.)
 * are unresolvable by getByRole — every ref to them was a guaranteed 30s
 * timeout (the wave-2/3 form-fill loops). The snapshot now exposes the
 * date as ONE ref'd fillable element, drops the shadow parts, and resolves
 * the ref via getByLabel (fill YYYY-MM-DD works natively on input[type=date]).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { AriaSnapshotHelper } from '../src/drivers/snapshot.js'

// Exact shape captured in the wave-3 bench artifact (turn-2 form snapshot).
const RAW_WITH_DATE_GROUP = `- textbox "First Name" [value="Jordan"]
- Date "Date of Birth":
  - spinbutton "Month Month" [value="0"]
  - spinbutton "Day Day" [value="0"]
  - spinbutton "Year Year" [value="0"]
  - button "Show date picker"
- radio "Other"
- button "Next"`

describe('AriaSnapshotHelper Chrome Date-control handling', () => {
  it('rewrites the Date group to a single ref\'d fillable line and drops shadow parts', () => {
    const helper = new AriaSnapshotHelper()
    // parseAriaSnapshot is private; reach in (same pattern as other tests).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (helper as any).parseAriaSnapshot(RAW_WITH_DATE_GROUP) as string
    expect(out).toContain('date "Date of Birth" [ref=')
    expect(out).toContain('YYYY-MM-DD')
    expect(out).not.toContain('spinbutton')
    expect(out).not.toContain('Show date picker')
    // Siblings survive untouched.
    expect(out).toContain('textbox "First Name"')
    expect(out).toContain('radio "Other"')
  })

  it('resolves the date ref via getByLabel and fills YYYY-MM-DD', async () => {
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const page: Page = await browser.newPage()
      await page.setContent('<label for="dob">Date of Birth</label><input id="dob" type="date" />')
      const helper = new AriaSnapshotHelper()
      helper.importCdpRefs(new Map([['d0b1', { role: 'Date', name: 'Date of Birth' }]]), new Map())
      const locator = helper.resolveLocator(page, '@d0b1')
      await expect(locator.count()).resolves.toBe(1)
      await locator.fill('1990-04-15')
      await expect(page.locator('#dob').inputValue()).resolves.toBe('1990-04-15')
    } finally {
      await browser?.close()
    }
  })
})
