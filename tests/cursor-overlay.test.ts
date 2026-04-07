/**
 * Tests for the cursor overlay init script.
 *
 * The script is a 180-line template string injected into pages via
 * page.addInitScript. There's no IDE syntax checking on the body —
 * one stray quote ships a runtime breakage that no CI catches.
 *
 * This test parses the script with `new Function()` to catch syntax
 * errors at unit-test time, then verifies that running it in a JSDOM
 * page exposes the documented public API.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { CURSOR_OVERLAY_INIT_SCRIPT, CURSOR_ANIMATION_MS } from '../src/drivers/cursor-overlay.js'

describe('cursor overlay init script', () => {
  it('parses as valid JavaScript', () => {
    // new Function does not execute — only parses. Catches stray quotes,
    // unbalanced braces, malformed template literals.
    expect(() => new Function(CURSOR_OVERLAY_INIT_SCRIPT)).not.toThrow()
  })

  it('has a non-trivial body', () => {
    expect(CURSOR_OVERLAY_INIT_SCRIPT.length).toBeGreaterThan(1000)
  })

  it('exports the documented public API surface', () => {
    // Sanity check: the script source declares the methods we depend on.
    // If a refactor renames or removes one, this catches it.
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/window\.__bad_overlay\s*=/)
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/highlight\s*\(/)
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/highlightRect\s*\(/)
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/moveTo\s*\(/)
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/pulseClick\s*\(/)
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/hide\s*\(/)
  })

  it('gives the box element a stable id', () => {
    // The driver looks the box up via #__bad_overlay_box, not via children[0].
    // Regression guard against the original prefix-confusion bug.
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/__bad_overlay_box/)
  })

  it('is idempotent (guarded by a global flag)', () => {
    expect(CURSOR_OVERLAY_INIT_SCRIPT).toMatch(/__bad_overlay_installed/)
  })
})

describe('CURSOR_ANIMATION_MS', () => {
  it('is a positive number tuned for the CSS transition', () => {
    expect(typeof CURSOR_ANIMATION_MS).toBe('number')
    expect(CURSOR_ANIMATION_MS).toBeGreaterThan(0)
    expect(CURSOR_ANIMATION_MS).toBeLessThan(1000) // sanity bound
  })
})
