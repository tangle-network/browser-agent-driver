/**
 * Wave-2 blind-selector loop kill: fail-closed rejection of guessed CSS
 * selectors (same pattern as the wave-1 [ref=] rejection).
 */

import { describe, expect, it } from 'vitest'
import { validateObservedSelector } from '../src/runner/selector-guard.js'

// ── validateObservedSelector (blind-selector loop kill) ─────────────────

describe('validateObservedSelector', () => {
  const snapshot = '- textbox "Email" [ref=t1]\n- button "Next" [ref=b2]\n- [data-testid="submit-btn"] button'

  it('rejects a guessed CSS selector and names the recovery path', () => {
    const err = validateObservedSelector(
      { action: 'click', selector: 'div.metric-card:nth-child(1) > div.metric-value' },
      snapshot,
      [],
    )
    expect(err).toContain('SELECTOR REJECTED')
    expect(err).toContain('extractWithIndex')
  })

  it('allows @refs, documented fallbacks, body, and observed selectors', () => {
    expect(validateObservedSelector({ action: 'click', selector: '@b2' }, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'click', selector: '[data-testid="submit-btn"]' }, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'click', selector: '[aria-label="Close"]' }, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'click', selector: 'text=Sign in' }, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'press', selector: 'body', key: 'Escape' }, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'click', selector: 'button "Next"' }, snapshot, [])).toBeNull()
  })

  it('allows selectors returned by prior runScript/extract results in the same run', () => {
    const evidence = ['EXTRACT RESULT (3 matches):\n[0] span.metric-value "12,418" selector=div.metric-card > span.metric-value']
    expect(
      validateObservedSelector(
        { action: 'click', selector: 'div.metric-card > span.metric-value' },
        snapshot,
        evidence,
      ),
    ).toBeNull()
  })

  it('checks every key of a fill batch', () => {
    const err = validateObservedSelector(
      { action: 'fill', fields: { '@t1': 'a', 'div.guess input': 'b' } },
      snapshot,
      [],
    )
    expect(err).toContain('div.guess input')
  })

  it('passes non-selector actions through', () => {
    expect(validateObservedSelector({ action: 'navigate', url: 'https://x' } as never, snapshot, [])).toBeNull()
    expect(validateObservedSelector({ action: 'scroll', direction: 'down', amount: 500 } as never, snapshot, [])).toBeNull()
  })
})

