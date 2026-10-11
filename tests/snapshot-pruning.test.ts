/**
 * Wave-3 snapshot serialization (browser-use serializer spirit):
 *   - nameless structural wrappers (rows, cells, layout tables, groups) and
 *     decorative images are dropped; named containers stay (they carry the
 *     data being extracted);
 *   - per-node display names cap at 120 chars, while ref resolution keeps
 *     the full accessible name (getByRole still matches);
 *   - decide() marks added elements inline with *new* instead of appending
 *     a duplicative SNAPSHOT CHANGES block.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import type { ModelMessage } from 'ai'
import { AriaSnapshotHelper } from '../src/drivers/snapshot.js'
import { Brain } from '../src/brain/index.js'
import type { PageState } from '../src/types/page.js'

const LONG_TITLE = 'A'.repeat(180)

const HTML = `
<!DOCTYPE html>
<html><body>
  <table>
    <tbody>
      <tr><td><a href="/story1">${LONG_TITLE}</a></td><td>247 points</td></tr>
      <tr><td><a href="/story2">Second story</a></td><td>89 comments</td></tr>
    </tbody>
  </table>
  <img src="decorative.png" />
  <img src="chart.png" alt="Quarterly revenue chart" />
  <input type="text" aria-label="Search" />
</body></html>
`

describe('AriaSnapshotHelper structural pruning + name caps', () => {
  let browser: Browser
  let page: Page
  let helper: AriaSnapshotHelper
  let snapshot: string

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(HTML)
    helper = new AriaSnapshotHelper()
    snapshot = await helper.buildSnapshot(page)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('drops nameless structural wrappers but keeps interactive + named content', () => {
    expect(snapshot).not.toContain('rowgroup')
    // The two story links survive with refs.
    expect(snapshot).toContain('link "Second story"')
    expect(snapshot).toMatch(/link "A+…?"/)
    // The data text (scores/comments) survives — that's the extraction moat.
    expect(snapshot).toContain('247 points')
    expect(snapshot).toContain('89 comments')
    expect(snapshot).toContain('textbox "Search"')
  })

  it('drops decorative images but keeps named ones', () => {
    expect(snapshot).not.toContain('decorative')
    expect(snapshot).toContain('Quarterly revenue chart')
  })

  it('caps long display names at 120 chars', () => {
    const line = snapshot.split('\n').find((l) => l.includes('AAAA'))
    expect(line).toBeDefined()
    expect(line).toContain('…')
    expect(line!.indexOf('[ref=')).toBeLessThanOrEqual(150)
  })

  it('still resolves a capped-name ref via the full accessible name', async () => {
    const line = snapshot.split('\n').find((l) => l.includes('AAAA') && l.includes('[ref='))
    const ref = line!.match(/\[ref=(\w+)\]/)![1]
    const locator = helper.resolveLocator(page, `@${ref}`)
    await expect(locator.count()).resolves.toBe(1)
    await expect(locator.first().textContent()).resolves.toBe(LONG_TITLE)
  })
})

describe('decide inline *new* markers', () => {
  const state: PageState = {
    url: 'https://example.com',
    title: 't',
    snapshot: '- link "Old" [ref=l1]\n- link "Brand new" [ref=l2]',
    snapshotDiffRaw: {
      added: ['+ link "Brand new" [ref=l2]'],
      removed: [],
      changed: [],
      unchangedCount: 1,
    },
  } as PageState

  it('annotates added refs inline and skips the duplicate diff block', async () => {
    const brain = new Brain({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'sk-test', vision: false })
    const captured: ModelMessage[][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(brain as any).generate = async (_s: unknown, messages: ModelMessage[]) => {
      captured.push(messages)
      return { text: '{"action":{"action":"wait","ms":1000},"reasoning":"r","expectedEffect":"e","currentStep":0,"plan":["x"]}' }
    }
    await brain.decide('goal', state, undefined, { current: 1, max: 8 })
    await brain.decide('goal', state, undefined, { current: 2, max: 8 })
    const text = String(captured[1][captured[1].length - 1].content)
    expect(text).toContain('- link "Brand new" [ref=l2] *new*')
    expect(text).not.toContain('SNAPSHOT CHANGES')
  })
})
