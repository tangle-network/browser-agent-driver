/**
 * Tests for the deterministic UI pattern matchers.
 *
 * Patterns must be SPECIFIC — false positives waste a turn (worse than no
 * skip). These tests pin both positive matches and the negative cases that
 * could otherwise mistrigger.
 */

import { describe, expect, it } from 'vitest'
import { matchDeterministicPattern } from '../src/runner/deterministic-patterns.js'
import type { PageState } from '../src/types.js'

function makeState(snapshot: string, url = 'https://example.com'): PageState {
  return { url, title: 'Test', snapshot }
}

describe('cookie banner matcher', () => {
  it('matches a clear cookie banner with an Accept button', () => {
    const state = makeState(`
banner [ref=b1]
  paragraph "We use cookies to enhance your experience"
  button [ref=b2] "Accept all"
  button [ref=b3] "Reject"
`)
    const match = matchDeterministicPattern(state)
    expect(match).not.toBeNull()
    expect(match?.patternId).toBe('cookie-banner-accept')
    expect(match?.action).toEqual({ action: 'click', selector: '@b2' })
  })

  it('matches the REAL ARIA snapshot format (ref AFTER quoted name, YAML-list indent)', () => {
    // This is the actual format the runner produces — captured live from
    // bench/fixtures/cookie-banner.html during evolve round 1. Earlier
    // versions of the matcher used a positional regex that required the
    // ref BEFORE the quoted name and missed every real cookie banner.
    const state = makeState(`- banner "Cookie consent":
  - link "privacy policy" [ref=lcfb]
  - button "Accept all" [ref=bfba]
- heading "Article Title" [ref=h2d83]
- link "Read article" [ref=l21eb]`)
    const match = matchDeterministicPattern(state)
    expect(match).not.toBeNull()
    expect(match?.patternId).toBe('cookie-banner-accept')
    expect(match?.action).toEqual({ action: 'click', selector: '@bfba' })
  })

  it('matches a GDPR consent dialog with Agree button', () => {
    const state = makeState(`
dialog [ref=d1] "Privacy & GDPR"
  paragraph "By continuing you agree to our cookie policy."
  button [ref=b1] "I agree"
`)
    const match = matchDeterministicPattern(state)
    expect(match).not.toBeNull()
    expect(match?.action).toEqual({ action: 'click', selector: '@b1' })
  })

  it('does NOT match a generic Continue button outside any cookie context', () => {
    const state = makeState(`
form [ref=f1]
  textbox [ref=t1] "Email"
  button [ref=b1] "Continue"
`)
    const match = matchDeterministicPattern(state)
    expect(match).toBeNull()
  })

  it('does NOT match a button labeled Accept on a non-banner page', () => {
    const state = makeState(`
heading [ref=h1] "Settings"
button [ref=b1] "Accept invitation"
list [ref=l1]
  link [ref=k1] "Profile"
`)
    const match = matchDeterministicPattern(state)
    expect(match).toBeNull()
  })

  it('matches when the consent keyword is in a nearby text node, not the button itself', () => {
    const state = makeState(`
banner [ref=b1] "Tracking notice"
  paragraph "We use tracking cookies for analytics."
  button [ref=b2] "Got it"
`)
    const match = matchDeterministicPattern(state)
    expect(match?.action).toEqual({ action: 'click', selector: '@b2' })
    expect(match?.patternId).toBe('cookie-banner-accept')
  })
})

describe('single-button modal matcher', () => {
  it('matches a modal with one "Close" button', () => {
    const state = makeState(`
heading [ref=h1] "Page"
dialog [ref=d1] "Notice"
  paragraph "Your changes have been saved."
  button [ref=b1] "Close"
`)
    const match = matchDeterministicPattern(state)
    expect(match).not.toBeNull()
    expect(match?.patternId).toBe('single-button-modal-close')
    expect(match?.action).toEqual({ action: 'click', selector: '@b1' })
  })

  it('matches an "OK" button in a single-action modal', () => {
    const state = makeState(`
alertdialog [ref=a1] "Info"
  paragraph "Operation completed."
  button [ref=b1] "OK"
`)
    const match = matchDeterministicPattern(state)
    expect(match?.patternId).toBe('single-button-modal-close')
  })

  it('does NOT match a confirmation dialog with Yes/No', () => {
    const state = makeState(`
dialog [ref=d1] "Confirm"
  paragraph "Delete this item?"
  button [ref=b1] "Yes"
  button [ref=b2] "No"
`)
    const match = matchDeterministicPattern(state)
    expect(match).toBeNull()
  })

  it('does NOT match a Save/Cancel dialog', () => {
    const state = makeState(`
dialog [ref=d1] "Edit profile"
  textbox [ref=t1] "Name"
  button [ref=b1] "Save"
  button [ref=b2] "Cancel"
`)
    const match = matchDeterministicPattern(state)
    expect(match).toBeNull()
  })
})

describe('matchDeterministicPattern dispatch order', () => {
  it('cookie banner wins when both a cookie banner and a single-close modal would match', () => {
    // The cookie banner matcher runs first; both could fire on this state.
    const state = makeState(`
banner [ref=b1] "We use cookies"
  button [ref=b2] "Accept"
dialog [ref=d1]
  button [ref=b3] "Close"
`)
    const match = matchDeterministicPattern(state)
    expect(match?.patternId).toBe('cookie-banner-accept')
  })

  it('returns null when no matcher fires', () => {
    const state = makeState(`
heading [ref=h1] "Welcome"
paragraph "This is a regular page."
link [ref=l1] "Learn more"
link [ref=l2] "Contact"
button [ref=b1] "Subscribe"
button [ref=b2] "Sign in"
`)
    expect(matchDeterministicPattern(state)).toBeNull()
  })
})
