/**
 * Integration test for the Gen 6 batch action verbs (fill, clickSequence)
 * against a real Chromium page. The pure-JS parser tests are in
 * tests/batch-action-parse.test.ts; this file pins end-to-end execution.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'

const FORM_HTML = `
<!DOCTYPE html>
<html><body>
  <h1>Batch Fill Test</h1>
  <form id="f">
    <input id="firstname" data-testid="firstname" type="text" />
    <input id="lastname" data-testid="lastname" type="text" />
    <input id="email" data-testid="email" type="email" />
    <select id="state" data-testid="state">
      <option value="">--</option>
      <option value="CA">California</option>
      <option value="WA">Washington</option>
      <option value="NY">New York</option>
    </select>
    <label><input id="terms" data-testid="terms" type="checkbox" /> Terms</label>
    <label><input id="news" data-testid="news" type="checkbox" /> Newsletter</label>
    <button type="button" id="submit" data-testid="submit">Submit</button>
  </form>
  <p data-testid="status">unsubmitted</p>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.querySelector('[data-testid="status"]').textContent = 'submitted';
    });
  </script>
</body></html>
`

describe('PlaywrightDriver batch action verbs', () => {
  let browser: Browser
  let page: Page
  let driver: PlaywrightDriver

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(FORM_HTML)
    driver = new PlaywrightDriver(page, { showCursor: false })
    // Trigger an observe so the snapshot helper builds its ref map
    await driver.observe()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('fill: types into multiple text fields in one action', async () => {
    const result = await driver.execute({
      action: 'fill',
      fields: {
        '[data-testid="firstname"]': 'Jordan',
        '[data-testid="lastname"]': 'Rivera',
        '[data-testid="email"]': 'jordan@example.com',
      },
    })
    expect(result.success).toBe(true)
    expect(await page.inputValue('[data-testid="firstname"]')).toBe('Jordan')
    expect(await page.inputValue('[data-testid="lastname"]')).toBe('Rivera')
    expect(await page.inputValue('[data-testid="email"]')).toBe('jordan@example.com')
  })

  it('fill: handles selects and checkboxes alongside text fields', async () => {
    const result = await driver.execute({
      action: 'fill',
      selects: { '[data-testid="state"]': 'WA' },
      checks: ['[data-testid="terms"]', '[data-testid="news"]'],
    })
    expect(result.success).toBe(true)
    expect(await page.inputValue('[data-testid="state"]')).toBe('WA')
    expect(await page.isChecked('[data-testid="terms"]')).toBe(true)
    expect(await page.isChecked('[data-testid="news"]')).toBe(true)
  })

  it('fill: bails on the first missing selector and reports which one failed', async () => {
    const result = await driver.execute({
      action: 'fill',
      fields: {
        '[data-testid="firstname"]': 'Alex',
        '[data-testid="nonexistent"]': 'oops',
        '[data-testid="lastname"]': 'never-runs',
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/nonexistent/)
    // The first field should still have been filled before the bail
    expect(await page.inputValue('[data-testid="firstname"]')).toBe('Alex')
  }, 15_000)

  it('fill: rejects an empty payload', async () => {
    const result = await driver.execute({ action: 'fill' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/at least one of/)
  })

  it('clickSequence: clicks refs in order', async () => {
    // Reset the form
    await page.evaluate(() => {
      document.querySelector<HTMLInputElement>('[data-testid="terms"]')!.checked = false
      document.querySelector<HTMLInputElement>('[data-testid="news"]')!.checked = false
      document.querySelector('[data-testid="status"]')!.textContent = 'unsubmitted'
    })
    const result = await driver.execute({
      action: 'clickSequence',
      refs: ['[data-testid="terms"]', '[data-testid="news"]', '[data-testid="submit"]'],
      intervalMs: 0,
    })
    expect(result.success).toBe(true)
    expect(await page.isChecked('[data-testid="terms"]')).toBe(true)
    expect(await page.isChecked('[data-testid="news"]')).toBe(true)
    expect(await page.textContent('[data-testid="status"]')).toBe('submitted')
  })

  it('clickSequence: bails on the first missing ref and reports which step failed', async () => {
    const result = await driver.execute({
      action: 'clickSequence',
      refs: ['[data-testid="terms"]', '[data-testid="ghost"]', '[data-testid="news"]'],
      intervalMs: 0,
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/step 2\/3/)
    expect(result.error).toMatch(/ghost/)
  }, 15_000)
})
