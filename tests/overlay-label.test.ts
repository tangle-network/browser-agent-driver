/**
 * Cursor-overlay label builder. The overlay renders ONE short label next
 * to the animated cursor; it's the primary signal in every demo video for
 * what the agent is actually doing. These tests pin the format so
 * regressions ("label shows bare `type` instead of the typed string") get
 * caught at CI time, not when someone reviews a recorded demo.
 */
import { describe, it, expect } from 'vitest'
import { formatOverlayLabel } from '../src/drivers/overlay-label.js'
import type { Action } from '../src/types.js'

describe('formatOverlayLabel', () => {
  it('click with accessible name → "click · <name>"', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'Search' })).toBe('click · Search')
  })

  it('click without name → bare "click"', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a)).toBe('click')
  })

  it('click with generic name ("button") drops the name — no info added', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'button' })).toBe('click')
  })

  it('type with text and target name → `type "<text>" · <name>`', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'IVANOV ALEKSANDR' }
    expect(formatOverlayLabel(a, { targetName: 'Last Name' })).toBe('type "IVANOV ALEKSANDR" · Last Name')
  })

  it('type with text but no name → `type · "<text>"`', () => {
    const a: Action = { action: 'type', selector: '@t1', text: 'PUTIN VLADIMIR' }
    expect(formatOverlayLabel(a)).toBe('type · "PUTIN VLADIMIR"')
  })

  it('type truncates long text with ellipsis', () => {
    const a: Action = {
      action: 'type',
      selector: '@t1',
      text: 'a very long string of text that should be truncated for overlay display',
    }
    const label = formatOverlayLabel(a)
    expect(label.length).toBeLessThanOrEqual(48)
    expect(label).toContain('…')
    expect(label.startsWith('type')).toBe(true)
  })

  it('press with a key → "press · <key>"', () => {
    const a: Action = { action: 'press', selector: '@t1', key: 'Enter' }
    expect(formatOverlayLabel(a)).toBe('press · Enter')
  })

  it('press with key + target name → "press <key> · <name>"', () => {
    const a: Action = { action: 'press', selector: '@t1', key: 'Enter' }
    expect(formatOverlayLabel(a, { targetName: 'Last Name' })).toBe('press Enter · Last Name')
  })

  it('hover → "hover · <name>" when name present', () => {
    const a: Action = { action: 'hover', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: 'More options' })).toBe('hover · More options')
    expect(formatOverlayLabel(a)).toBe('hover')
  })

  it('select → includes both value and target name when available', () => {
    const a: Action = { action: 'select', selector: '@s1', value: 'CA' }
    expect(formatOverlayLabel(a, { targetName: 'State' })).toBe('select CA · State')
    expect(formatOverlayLabel(a)).toBe('select · CA')
  })

  it('scroll → "scroll <direction>"', () => {
    expect(formatOverlayLabel({ action: 'scroll', direction: 'down' })).toBe('scroll down')
    expect(formatOverlayLabel({ action: 'scroll', direction: 'up' })).toBe('scroll up')
  })

  it('navigate → "nav · <host>" (strips protocol and path)', () => {
    const a: Action = { action: 'navigate', url: 'https://sanctionssearch.ofac.treas.gov/some/path?query=1' }
    expect(formatOverlayLabel(a)).toBe('nav · sanctionssearch.ofac.treas.gov')
  })

  it('navigate with a malformed URL falls back to a best-effort slice', () => {
    const a: Action = { action: 'navigate', url: 'not-a-url-at-all' }
    expect(formatOverlayLabel(a)).toBe('nav · not-a-url-at-all')
  })

  it('wait → "wait Xms"', () => {
    expect(formatOverlayLabel({ action: 'wait', ms: 250 })).toBe('wait 250ms')
  })

  it('label never exceeds MAX_LABEL_LEN (48) regardless of input', () => {
    const a: Action = {
      action: 'type',
      selector: '@t1',
      text: 'a'.repeat(200),
    }
    const label = formatOverlayLabel(a, { targetName: 'b'.repeat(200) })
    expect(label.length).toBeLessThanOrEqual(48)
  })

  it('whitespace in target name is collapsed (newlines, tabs, doubled spaces)', () => {
    const a: Action = { action: 'click', selector: '@b1' }
    expect(formatOverlayLabel(a, { targetName: '  Search\n\nnow  ' })).toBe('click · Search now')
  })

  it('unknown action type falls back to the action verb (never throws)', () => {
    // Cast to Action to exercise the default branch
    const a = { action: 'complete', result: 'done' } as unknown as Action
    expect(formatOverlayLabel(a)).toBe('complete')
  })
})
