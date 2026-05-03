/**
 * extractWithIndex action tests.
 *
 * Two layers:
 *   1. Parser unit tests (Brain.parse → ExtractWithIndexAction object)
 *   2. Integration tests against a real Chromium page (runExtractWithIndex
 *      + formatExtractWithIndexResult)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { runExtractWithIndex, formatExtractWithIndexResult } from '../src/drivers/extract-with-index.js'
import { Brain } from '../src/brain/index.js'

const TEST_HTML = `
<!DOCTYPE html>
<html><body>
  <h1>Array.prototype.flatMap</h1>
  <dl>
    <dt><code>flatMap(callbackFn)</code></dt>
    <dd>Returns a new array formed by applying a function to each element.</dd>
    <dt><code>flatMap(callbackFn, thisArg)</code></dt>
    <dd>Returns a new array, with thisArg bound.</dd>
  </dl>
  <pre><code id="example-code">const result = arr.flatMap(x => [x, x*2]);</code></pre>
  <p data-testid="downloads">Weekly downloads: 26,543,821</p>
  <p>An unrelated paragraph about other topics, with no special filter words.</p>
  <button>Edit on GitHub</button>
  <a href="#">Skip to content</a>
  <span style="display:none">Hidden span should not appear</span>
</body></html>
`

describe('extractWithIndex helper', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.setContent(TEST_HTML)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('returns visible elements matching the query', async () => {
    const matches = await runExtractWithIndex(page, 'p, dd, code')
    // Should find: 2 dd, 2 dt>code, 1 pre>code, 2 p (downloads + unrelated)
    expect(matches.length).toBeGreaterThanOrEqual(6)
    // All matches should have non-empty text
    for (const m of matches) {
      expect(typeof m.text).toBe('string')
      expect(m.index).toBeGreaterThanOrEqual(0)
      expect(m.tag).toBeTruthy()
    }
  })

  it('filters by `contains` substring (case-insensitive)', async () => {
    const matches = await runExtractWithIndex(page, 'p, dd, code', 'callbackfn')
    // Only matches text containing "callbackFn" — the two <dt><code> blocks
    expect(matches.length).toBe(2)
    expect(matches[0].text.toLowerCase()).toContain('callbackfn')
    expect(matches[1].text.toLowerCase()).toContain('callbackfn')
  })

  it('filters by `contains` for npm-style download text', async () => {
    const matches = await runExtractWithIndex(page, 'p, span, strong', 'downloads')
    expect(matches.length).toBe(1)
    expect(matches[0].text).toContain('Weekly downloads: 26,543,821')
    expect(matches[0].attributes['data-testid']).toBe('downloads')
  })

  it('skips hidden elements (display:none)', async () => {
    const matches = await runExtractWithIndex(page, 'span')
    // The hidden span should not appear
    const hidden = matches.find(m => m.text.includes('Hidden span'))
    expect(hidden).toBeUndefined()
  })

  it('returns empty array on invalid selector instead of throwing', async () => {
    const matches = await runExtractWithIndex(page, '<<invalid>>>')
    expect(matches).toEqual([])
  })

  it('produces stable selectors that can be re-used', async () => {
    const matches = await runExtractWithIndex(page, 'p[data-testid]')
    expect(matches[0].selector).toBe('[data-testid="downloads"]')
  })

  it('builds id-based selector when element has a clean id', async () => {
    const matches = await runExtractWithIndex(page, '#example-code')
    expect(matches.length).toBe(1)
    expect(matches[0].selector).toBe('#example-code')
  })
})

describe('formatExtractWithIndexResult', () => {
  it('formats matches as numbered list with index, tag, attributes, text', () => {
    const matches = [
      { index: 0, tag: 'p', text: 'Weekly downloads: 26,543,821', attributes: { 'data-testid': 'downloads' }, selector: '[data-testid="downloads"]' },
      { index: 1, tag: 'code', text: 'flatMap(callbackFn)', attributes: {}, selector: 'code:nth-of-type(1)' },
    ]
    const out = formatExtractWithIndexResult(matches, 'p, code')
    expect(out).toContain('[0] <p>')
    expect(out).toContain('data-testid="downloads"')
    expect(out).toContain('Weekly downloads')
    expect(out).toContain('[1] <code>')
    expect(out).toContain('flatMap(callbackFn)')
  })

  it('reports zero-match case explicitly', () => {
    const out = formatExtractWithIndexResult([], 'foo', 'bar')
    expect(out).toContain('no matches')
    expect(out).toContain('foo')
    expect(out).toContain('bar')
  })

  it('includes truncation note when at the cap', () => {
    const matches = Array.from({ length: 80 }, (_, i) => ({
      index: i,
      tag: 'a',
      text: `link ${i}`,
      attributes: {},
      selector: `a:nth-of-type(${i + 1})`,
    }))
    const out = formatExtractWithIndexResult(matches, 'a')
    expect(out).toContain('capped')
  })
})

describe('extractWithIndex action parser', () => {
  // Brain.parse is private; tests reach it via the same as-cast pattern as
  // tests/brain-parse.test.ts.
  type ParsedDecision = { action: { action: string; query?: string; contains?: string } }

  it('parses a valid extractWithIndex action with query only', () => {
    const brain = new Brain()
    const parsed = (brain as unknown as { parse: (raw: string) => ParsedDecision }).parse(
      JSON.stringify({
        action: { action: 'extractWithIndex', query: 'p, dd, code' },
        reasoning: 'Looking for the downloads number',
      }),
    )
    expect(parsed.action.action).toBe('extractWithIndex')
    expect(parsed.action.query).toBe('p, dd, code')
    expect(parsed.action.contains).toBeUndefined()
  })

  it('parses extractWithIndex with contains filter', () => {
    const brain = new Brain()
    const parsed = (brain as unknown as { parse: (raw: string) => ParsedDecision }).parse(
      JSON.stringify({
        action: { action: 'extractWithIndex', query: 'p, span, strong', contains: 'downloads' },
        reasoning: 'Looking for the downloads number',
      }),
    )
    expect(parsed.action.action).toBe('extractWithIndex')
    expect(parsed.action.query).toBe('p, span, strong')
    expect(parsed.action.contains).toBe('downloads')
  })

  it('falls back to wait when extractWithIndex is missing query', () => {
    // Brain.parse swallows validation errors and returns a wait fallback so
    // the loop can recover. Confirm extractWithIndex without `query` triggers
    // that fallback and includes the validation error in the reasoning.
    const brain = new Brain()
    const parsed = (brain as unknown as { parse: (raw: string) => { action: { action: string }; reasoning?: string } }).parse(
      JSON.stringify({
        action: { action: 'extractWithIndex', contains: 'downloads' },
        reasoning: '...',
      }),
    )
    expect(parsed.action.action).toBe('wait')
    expect(parsed.reasoning).toMatch(/extractWithIndex/i)
  })
})
