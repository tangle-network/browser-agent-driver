/**
 * budgetSnapshot must preserve content lines (term, definition,
 * code, pre, paragraph) when budget allows. Without this fix, MDN-style
 * `<dl>/<dt>/<dd>` content and Python docs `<code>` blocks get dropped from
 * the snapshot, leaving the LLM with no way to write a working runScript.
 *
 * The actual filter regex tested here is the second-pass content filter at
 * brain/index.ts:budgetSnapshot — when the full snapshot exceeds the budget,
 * we keep interactive elements + content lines and drop only true decoration.
 */

import { describe, expect, it } from 'vitest'
import { budgetSnapshot } from '../src/brain/index.js'

const SHORT_INTERACTIVE = `- heading "Test page" [level=1] [ref=h1a]
- button "A button" [ref=b2c]
- link "A link" [ref=l3f]`

const SHORT_WITH_CONTENT = `- heading "Array.prototype.flatMap" [level=1] [ref=h1a]
- term:
  - code: flatMap(callbackFn)
- definition: Returns a new array formed by applying a function to each element.
- term:
  - code: flatMap(callbackFn, thisArg)
- definition: With thisArg.
- pre:
  - code: const result = arr.flatMap(x => [x, x*2]);
- button "Edit on GitHub" [ref=b2c]`

describe('budgetSnapshot', () => {
  it('returns full snapshot when under budget', () => {
    const out = budgetSnapshot(SHORT_INTERACTIVE, 24_000)
    expect(out).toBe(SHORT_INTERACTIVE)
  })

  it('preserves content lines (term/definition/code/pre) when under budget', () => {
    const out = budgetSnapshot(SHORT_WITH_CONTENT, 24_000)
    // Under budget — full snapshot returned unchanged
    expect(out).toContain('flatMap(callbackFn)')
    expect(out).toContain('flatMap(callbackFn, thisArg)')
    expect(out).toContain('Returns a new array')
    expect(out).toContain('arr.flatMap(x => [x, x*2])')
  })

  it('preserves content lines when over budget (filter mode)', () => {
    // Pad each line so 200 lines comfortably exceeds 5k chars and forces filtering
    const padding = Array.from(
      { length: 200 },
      (_, i) => `- img "decorative ad banner element number ${i} with extra padding to push char count"`,
    ).join('\n')
    const big = SHORT_WITH_CONTENT + '\n' + padding
    expect(big.length).toBeGreaterThan(5_000)

    const out = budgetSnapshot(big, 4_000)
    // Content lines must survive the filter
    expect(out).toContain('flatMap(callbackFn)')
    expect(out).toContain('flatMap(callbackFn, thisArg)')
    expect(out).toContain('Returns a new array')
    expect(out).toContain('arr.flatMap(x => [x, x*2])')
    // Decorative img lines should be omitted
    expect(out).toContain('decorative elements omitted')
    // Interactive elements with refs survive
    expect(out).toContain('Edit on GitHub')
  })

  it('drops decorative img/separator lines when over budget', () => {
    // Each img line ~80 chars × 100 = 8k well above 2k budget
    const decoration = Array.from(
      { length: 100 },
      (_, i) => `- img "icon ${i} long descriptive name to inflate character count beyond filter trigger"`,
    ).join('\n')
    const small = `- button "Submit" [ref=b1]\n- link "Cancel" [ref=l1]\n${decoration}`
    expect(small.length).toBeGreaterThan(2_000)
    const out = budgetSnapshot(small, 200)
    expect(out).toContain('Submit')
    expect(out).toContain('Cancel')
    // Decorative count should appear in the omission note
    expect(out).toMatch(/decorative.*omitted/)
  })

  it('content lines stay in priority bucket when interactive+content overflows', () => {
    // deduplicateSnapshot strips digits before grouping, so use word-only names
    // that are genuinely distinct. ~200 buttons with letter suffixes won't collapse.
    const letters = 'abcdefghijklmnopqrstuvwxyz'
    const namesAA = letters.split('').flatMap(a => letters.split('').map(b => `${a}${b}`))
    const manyButtons = namesAA
      .slice(0, 200)
      .map((nm) => `- button "Action ${nm} with sufficient padding text content here for char count" [ref=b${nm}]`)
      .join('\n')
    const big = SHORT_WITH_CONTENT + '\n' + manyButtons
    expect(big.length).toBeGreaterThan(8_000)

    const out = budgetSnapshot(big, 2_500)
    // Content lines must still be present (priority bucket)
    expect(out).toContain('flatMap(callbackFn)')
    expect(out).toContain('Returns a new array')
    // Not all buttons survive — confirm trimming happened
    expect(out).toContain('omitted')
  })

  it('paragraph content lines are preserved', () => {
    const withParagraphs = `- heading "Article" [ref=h1]
- paragraph: This is the abstract that the agent needs to extract.
- paragraph: Another important sentence.
- button "Read more" [ref=b1]`
    const out = budgetSnapshot(withParagraphs, 24_000)
    expect(out).toContain('This is the abstract')
    expect(out).toContain('Another important sentence')
  })
})
