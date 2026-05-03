/**
 * Cursor-overlay label builder. These tests pin the human-readable
 * format so regressions (verbose labels like `type JOHN SMITH · last
 * name insert criteria, required *`) get caught at CI time.
 *
 * Natural-English sentences with aggressive suffix cleanup.
 */
import { describe, it, expect } from 'vitest'
import { formatOverlayLabel } from '../src/drivers/overlay-label.js'
import type { Action } from '../src/types.js'

describe('formatOverlayLabel', () => {
  it('click with accessible name reads as a sentence', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'Search' })).toBe('Clicking Search')
  })

  it('click without name', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a)).toBe('Clicking')
  })

  it('click with generic role name drops the name', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'button' })).toBe('Clicking')
    expect(formatOverlayLabel(a, { targetName: 'textbox' })).toBe('Clicking')
  })

  it('type into a named field', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'IVANOV ALEKSANDR' }
    expect(formatOverlayLabel(a, { targetName: 'Last Name' })).toBe('Typing IVANOV ALEKSANDR into Last Name')
  })

  it('type strips verbose ARIA suffixes — the Drew regression', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'JOHN SMITH' }
    // OFAC-style aria labels — leading "Enter ..." and trailing noise
    expect(formatOverlayLabel(a, { targetName: 'Enter name as search criteria' })).toBe('Typing JOHN SMITH into Name')
    expect(formatOverlayLabel(a, { targetName: 'Last Name: insert criteria' })).toBe('Typing JOHN SMITH into Last Name')
    expect(formatOverlayLabel(a, { targetName: 'Email, required *' })).toBe('Typing JOHN SMITH into Email')
    expect(formatOverlayLabel(a, { targetName: 'Last name*' })).toBe('Typing JOHN SMITH into Last name')
    expect(formatOverlayLabel(a, { targetName: 'Please enter your email address' })).toBe('Typing JOHN SMITH into Email address')
  })

  it('type drops name when it is a long sentence, not a field label', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'JOHN SMITH' }
    // When the ARIA text is an entire instruction rather than a noun,
    // don't jam a truncated fragment into the label. Prefer the bare verb.
    const longAria = 'Please fill in each of the following fields carefully before submitting'
    expect(formatOverlayLabel(a, { targetName: longAria })).toBe('Typing JOHN SMITH')
  })

  it('type without name', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'PUTIN VLADIMIR' }
    expect(formatOverlayLabel(a)).toBe('Typing PUTIN VLADIMIR')
  })

  it('type truncates long text with ellipsis, cap respected', () => {
    const a: Action = {
      action: 'type',
      selector: '@t1',
      text: 'a very long string of text that should be truncated for overlay display',
    }
    const label = formatOverlayLabel(a)
    expect(label.length).toBeLessThanOrEqual(56)
    expect(label).toContain('…')
    expect(label.startsWith('Typing')).toBe(true)
  })

  it('press with a friendly key name', () => {
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'Enter' })).toBe('Pressing Enter')
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'Return' })).toBe('Pressing Enter')
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'Tab' })).toBe('Pressing Tab')
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'Escape' })).toBe('Pressing Esc')
  })

  it('press with arrow key glyph', () => {
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'ArrowDown' })).toBe('Pressing ↓')
    expect(formatOverlayLabel({ action: 'press', selector: '@t1', key: 'ArrowRight' })).toBe('Pressing →')
  })

  it('press with key + target name reads cleanly', () => {
    const a: Action = { action: 'press', selector: '@t1', key: 'Enter' }
    expect(formatOverlayLabel(a, { targetName: 'Last Name' })).toBe('Pressing Enter in Last Name')
  })

  it('hover', () => {
    const a: Action = { action: 'hover', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'More options' })).toBe('Hovering More options')
    expect(formatOverlayLabel(a)).toBe('Hovering')
  })

  it('select', () => {
    const a: Action = { action: 'select', selector: '@s1', value: 'CA' }
    expect(formatOverlayLabel(a, { targetName: 'State' })).toBe('Selecting CA in State')
    expect(formatOverlayLabel(a)).toBe('Selecting CA')
  })

  it('scroll', () => {
    expect(formatOverlayLabel({ action: 'scroll', direction: 'down' })).toBe('Scrolling down')
    expect(formatOverlayLabel({ action: 'scroll', direction: 'up' })).toBe('Scrolling up')
  })

  it('navigate strips protocol and path', () => {
    const a: Action = { action: 'navigate', url: 'https://sanctionssearch.ofac.treas.gov/some/path?query=1' }
    expect(formatOverlayLabel(a)).toBe('Navigating to sanctionssearch.ofac.treas.gov')
  })

  it('navigate with malformed URL falls back to best-effort', () => {
    const a: Action = { action: 'navigate', url: 'not-a-url-at-all' }
    expect(formatOverlayLabel(a)).toBe('Navigating to not-a-url-at-all')
  })

  it('wait', () => {
    expect(formatOverlayLabel({ action: 'wait', ms: 250 })).toBe('Waiting 250ms')
  })

  it('label never exceeds MAX_LABEL_LEN (56) regardless of input', () => {
    const a: Action = {
      action: 'type',
      selector: '@t1',
      text: 'a'.repeat(200),
    }
    const label = formatOverlayLabel(a, { targetName: 'b'.repeat(200) })
    expect(label.length).toBeLessThanOrEqual(56)
  })

  it('whitespace in target name is collapsed', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: '  Search\n\nnow  ' })).toBe('Clicking Search now')
  })

  it('unknown action falls back to the action verb', () => {
    const a = { action: 'complete', result: 'done' } as unknown as Action
    expect(formatOverlayLabel(a)).toBe('complete')
  })
})
