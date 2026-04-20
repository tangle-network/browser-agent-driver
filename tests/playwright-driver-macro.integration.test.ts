/**
 * Integration test for Gen 29 macro dispatch inside PlaywrightDriver.
 * Drives a real Chromium page with a small HTML fixture and asserts that
 * a macro composed of safe primitives executes end-to-end, including arg
 * interpolation, error propagation, and the missing-registry / missing-name
 * error paths.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'
import { buildMacroRegistry, validateMacroDefinition } from '../src/skills/macro-loader.js'
import type { MacroDefinition } from '../src/skills/macro-loader.js'

const FIXTURE = `
<!DOCTYPE html>
<html><body>
  <h1>Macro Test</h1>
  <form id="f" onsubmit="event.preventDefault(); document.querySelector('[data-testid=status]').textContent = document.getElementById('q').value;">
    <input id="q" data-testid="q" type="text" />
    <button type="submit" data-testid="go">Go</button>
  </form>
  <p data-testid="status">idle</p>
</body></html>
`

function macroFrom(raw: unknown) {
  return validateMacroDefinition(raw, '/tmp/fake.json', false)
}

describe('PlaywrightDriver — macro dispatch', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  })

  beforeEach(async () => {
    // Reset fixture per test so earlier DOM mutations (e.g. status=hello)
    // can't mask later test failures.
    await page.setContent(FIXTURE)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('executes a search-and-submit macro end-to-end, substituting args', async () => {
    const registry = buildMacroRegistry([
      macroFrom({
        name: 'search-and-submit',
        description: 'focus → type → press Enter',
        params: [
          { name: 'searchRef', required: true },
          { name: 'query', required: true },
        ],
        steps: [
          { action: 'click', selector: '${searchRef}' },
          { action: 'type', selector: '${searchRef}', text: '${query}' },
          { action: 'press', selector: '${searchRef}', key: 'Enter' },
        ],
      }),
    ])
    const driver = new PlaywrightDriver(page, { macros: registry })
    await driver.observe()

    const result = await driver.execute({
      action: 'macro',
      name: 'search-and-submit',
      args: { searchRef: '[data-testid="q"]', query: 'hello' },
    })
    expect(result.success).toBe(true)
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="status"]') as HTMLElement)?.textContent === 'hello',
      undefined,
      { timeout: 2000 },
    )
  })

  it('errors when required arg is missing', async () => {
    const registry = buildMacroRegistry([
      macroFrom({
        name: 'needs-arg',
        description: 'x',
        params: [{ name: 'q', required: true }],
        steps: [{ action: 'wait', ms: 10 }],
      }),
    ])
    const driver = new PlaywrightDriver(page, { macros: registry })

    const result = await driver.execute({
      action: 'macro',
      name: 'needs-arg',
      args: {},
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/missing required arg "q"/)
  })

  it('errors when macro name is unknown', async () => {
    const registry = buildMacroRegistry([])
    const driver = new PlaywrightDriver(page, { macros: registry })

    const result = await driver.execute({
      action: 'macro',
      name: 'does-not-exist',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Unknown macro "does-not-exist"/)
  })

  it('errors when no registry is configured', async () => {
    const driver = new PlaywrightDriver(page, {}) // no macros

    const result = await driver.execute({
      action: 'macro',
      name: 'anything',
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No macro registry loaded/)
  })

  it('short-circuits on first step failure with contextual error', async () => {
    const registry = buildMacroRegistry([
      macroFrom({
        name: 'fails-mid',
        description: 'x',
        params: [],
        steps: [
          { action: 'wait', ms: 10 },
          { action: 'click', selector: '[data-testid="does-not-exist"]' },
          { action: 'wait', ms: 10 },
        ],
      }),
    ])
    const driver = new PlaywrightDriver(page, { macros: registry, timeout: 500 })
    await driver.observe()

    const result = await driver.execute({
      action: 'macro',
      name: 'fails-mid',
    })
    expect(result.success).toBe(false)
    // Error message names the macro, step index, and failing step type
    expect(result.error).toMatch(/macro "fails-mid" failed at step 2\/3 \(click\)/)
  })

  it('accepts optional args when required=false on the param', async () => {
    const registry = buildMacroRegistry([
      macroFrom({
        name: 'optional-arg',
        description: 'x',
        params: [{ name: 'q', required: false }],
        steps: [{ action: 'wait', ms: 5 }],
      }),
    ])
    const driver = new PlaywrightDriver(page, { macros: registry })
    const result = await driver.execute({
      action: 'macro',
      name: 'optional-arg',
      args: {},
    })
    expect(result.success).toBe(true)
  })

  it('defense-in-depth: runtime guard rejects a macro-step-of-type-macro if one bypasses the loader', async () => {
    // Hand-build a malicious registry that the loader would have rejected,
    // to prove the dispatch-time guard fires. This covers the scenario where
    // BAD_MACROS_DIR points at an attacker-controlled directory.
    const malicious: MacroDefinition = {
      name: 'evil',
      description: 'x',
      params: [],
      // deliberately bypass validateMacroDefinition with a direct object
      steps: [{ action: 'macro', name: 'other' } as unknown as MacroDefinition['steps'][number]],
      sourcePath: '/dev/null',
    }
    const registry = { macros: new Map([['evil', malicious]]), promptBlock: '' }
    const driver = new PlaywrightDriver(page, { macros: registry })
    const result = await driver.execute({ action: 'macro', name: 'evil' })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/nesting disallowed/)
  })
})
