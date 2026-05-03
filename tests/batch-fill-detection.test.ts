/**
 * Tests for the batch-fill opportunity detector. The runner injects a
 * "must batch next turn" hint when the agent starts filling a multi-field
 * form one field at a time.
 */

import { describe, expect, it } from 'vitest'
import type { Turn, PageState } from '../src/types.js'

// The detector is private to runner.ts — we re-import it via a sibling
// helper module that re-exports it for tests. To avoid plumbing through
// runner.ts itself (which has a lot of dependencies), we inline the same
// detection logic in a typed test fixture and verify the contract.
//
// If runner.ts's exported function diverges from this fixture, the
// integration test (runner main loop) will catch it. Pure-JS tests stay
// fast and isolated.

import { detectBatchFillOpportunity } from '../src/runner/runner.js'

const URL = 'https://example.com/form'

function makeTurn(action: Turn['action'], url = URL): Turn {
  return {
    turn: 1,
    state: { url, title: 'Form', snapshot: '' },
    action,
    durationMs: 100,
  }
}

function makeState(snapshot: string): PageState {
  return { url: URL, title: 'Form', snapshot }
}

const SNAPSHOT_FORM = `
- form "signup":
  - textbox "First name" [ref=t1]
  - textbox "Last name" [ref=t2]
  - textbox "Email" [ref=t3]
  - textbox "Phone" [ref=t4]
  - combobox "State" [ref=c1]
  - button "Next" [ref=b1]
`

describe('detectBatchFillOpportunity', () => {
  it('returns null when there are no turns', () => {
    expect(detectBatchFillOpportunity([], makeState(SNAPSHOT_FORM))).toBeNull()
  })

  it('returns null when the last action is not type', () => {
    const turns = [makeTurn({ action: 'click', selector: '@b1' })]
    expect(detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))).toBeNull()
  })

  it('returns null when the URL changed between the last turn and the current state', () => {
    const turns = [
      makeTurn({ action: 'type', selector: '@t1', text: 'Jordan' }, 'https://example.com/step1'),
    ]
    const state: PageState = { url: 'https://example.com/step2', title: 'x', snapshot: SNAPSHOT_FORM }
    expect(detectBatchFillOpportunity(turns, state)).toBeNull()
  })

  it('returns null when fewer than 2 unused fillable refs remain', () => {
    const turns = [
      makeTurn({ action: 'type', selector: '@t1', text: 'a' }),
      makeTurn({ action: 'type', selector: '@t2', text: 'b' }),
      makeTurn({ action: 'type', selector: '@t3', text: 'c' }),
      makeTurn({ action: 'type', selector: '@t4', text: 'd' }),
    ]
    // Snapshot only has @t1-@t4 already used + @c1 (1 unused) + @b1 button
    expect(detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))).toBeNull()
  })

  it('fires after a single type action when 2+ unused fields remain', () => {
    // The agent just typed into firstname. The form has 4 more fillable
    // fields visible. Detector should fire on this very turn.
    const turns = [makeTurn({ action: 'type', selector: '@t1', text: 'Jordan' })]
    const hint = detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))
    expect(hint).not.toBeNull()
    expect(hint).toContain('BATCH FILL REQUIRED')
    // Lists unused refs: @t2-@t4 (textboxes), @c1 (combobox)
    expect(hint).toContain('@t2')
    expect(hint).toContain('@t3')
    expect(hint).toContain('@t4')
    expect(hint).toContain('@c1')
    // Does NOT re-list the just-typed ref
    expect(hint).not.toContain('@t1 (textbox')
  })

  it('fires after 3 consecutive type actions too (covers the original threshold)', () => {
    const turns = [
      makeTurn({ action: 'type', selector: '@t1', text: 'a' }),
      makeTurn({ action: 'type', selector: '@t2', text: 'b' }),
      makeTurn({ action: 'type', selector: '@t3', text: 'c' }),
    ]
    const hint = detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))
    expect(hint).not.toBeNull()
    expect(hint).toContain('@t4')
    expect(hint).toContain('@c1')
  })

  it('caps the listed unused refs at 12 to keep the prompt bounded', () => {
    const turns = [makeTurn({ action: 'type', selector: '@used1', text: 'a' })]
    // Snapshot with 20 unused refs
    let snap = ''
    for (let i = 1; i <= 20; i++) {
      snap += `  - textbox "field ${i}" [ref=field${i}]\n`
    }
    const hint = detectBatchFillOpportunity(turns, makeState(snap))
    expect(hint).not.toBeNull()
    // Should mention the first 12 but not all 20
    expect(hint).toContain('@field1')
    expect(hint).toContain('@field12')
    expect(hint).not.toContain('@field13')
    expect(hint).not.toContain('@field20')
  })

  it('includes a worked example with the first two unused refs', () => {
    const turns = [makeTurn({ action: 'type', selector: '@t1', text: 'a' })]
    const hint = detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))
    expect(hint).not.toBeNull()
    expect(hint).toMatch(/{"action":"fill","fields":\{"@t2":"value1","@t3":"value2"\}\}/)
  })

  it('does NOT re-list refs already filled via a previous batch fill', () => {
    const turns = [
      makeTurn({ action: 'fill', fields: { '@t1': 'Jordan', '@t2': 'Rivera' } }),
      makeTurn({ action: 'type', selector: '@t3', text: 'jordan@example.com' }),
    ]
    const hint = detectBatchFillOpportunity(turns, makeState(SNAPSHOT_FORM))
    expect(hint).not.toBeNull()
    // @t4 and @c1 are unused; @t1, @t2, @t3 are all already filled
    expect(hint).toContain('@t4')
    expect(hint).toContain('@c1')
    expect(hint).not.toContain('@t1 (textbox')
    expect(hint).not.toContain('@t2 (textbox')
    expect(hint).not.toContain('@t3 (textbox')
  })
})
