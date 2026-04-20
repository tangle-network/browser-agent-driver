/**
 * Gen 32 — overlay narration parsing.
 *
 * The runner parses LLM reasoning text to drive three overlay channels:
 * reasoning panel, progress label, verdict badges. These tests pin the
 * parse rules so regressions ("badges don't fire" / "progress chip shows
 * raw ledger markup") get caught at CI, not by reviewing video.
 */
import { describe, it, expect } from 'vitest'
import {
  summarizeReasoning,
  extractCurrentMarker,
  extractDoneCount,
  detectVerdicts,
  VerdictTracker,
  buildProgressLabel,
} from '../src/runner/overlay-narration.js'

describe('summarizeReasoning', () => {
  it('cuts at the first sentence boundary when short', () => {
    const r = 'Clicking Search to submit C-003. Then we check for matches.'
    expect(summarizeReasoning(r)).toBe('Clicking Search to submit C-003.')
  })

  it('hard-truncates with ellipsis when the first sentence is too long', () => {
    const r = 'a'.repeat(300) + '. rest'
    const s = summarizeReasoning(r)
    expect(s.length).toBeLessThanOrEqual(181)
    expect(s.endsWith('…')).toBe(true)
  })

  it('returns empty for undefined / empty / whitespace', () => {
    expect(summarizeReasoning(undefined)).toBe('')
    expect(summarizeReasoning('')).toBe('')
    expect(summarizeReasoning('   \n  \t')).toBe('')
  })

  it('collapses whitespace to single spaces', () => {
    const r = 'Turn   one.\n\nTurn two.'
    expect(summarizeReasoning(r)).toBe('Turn one.')
  })
})

describe('extractCurrentMarker', () => {
  it('parses Current=C-003 from ledger reasoning', () => {
    const r = 'Progress: Done=[C-001, C-002]. Current=C-003 (step 2/5: type last name).'
    expect(extractCurrentMarker(r)).toBe('C-003')
  })

  it('tolerates spaces around =', () => {
    expect(extractCurrentMarker('Progress: Current = C-042')).toBe('C-042')
  })

  it('returns undefined when no marker present', () => {
    expect(extractCurrentMarker('clicking button')).toBeUndefined()
    expect(extractCurrentMarker(undefined)).toBeUndefined()
    expect(extractCurrentMarker('')).toBeUndefined()
  })
})

describe('extractDoneCount', () => {
  it('counts ledger entries', () => {
    expect(extractDoneCount('Done=[C-001, C-002, C-003]')).toBe(3)
    expect(extractDoneCount('Done=[C-001:POSITIVE, C-002:CLEARED]')).toBe(2)
  })

  it('returns 0 for empty ledger', () => {
    expect(extractDoneCount('Done=[]')).toBe(0)
  })

  it('returns undefined when no ledger', () => {
    expect(extractDoneCount('just clicking stuff')).toBeUndefined()
    expect(extractDoneCount(undefined)).toBeUndefined()
  })

  it('tolerates trailing comma / extra whitespace', () => {
    expect(extractDoneCount('Done=[C-001, C-002,]')).toBe(2)
    expect(extractDoneCount('Done=[ C-001 , C-002 ]')).toBe(2)
  })
})

describe('detectVerdicts', () => {
  it('fires a POSITIVE badge when agent declares a positive match with customer id', () => {
    const r = 'C-003 PUTIN VLADIMIR: POSITIVE MATCH — Russia-EO14024 / SDN'
    const events = detectVerdicts(r)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('positive')
    expect(events[0].text).toContain('C-003')
    expect(events[0].text).toContain('POSITIVE')
    expect(events[0].marker).toBe('C-003:POSITIVE')
  })

  it('fires CLEARED with customer id', () => {
    const r = 'C-002 confirmed CLEARED — no matches'
    const events = detectVerdicts(r)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('cleared')
    expect(events[0].marker).toBe('C-002:CLEARED')
  })

  it('fires REVIEW with customer id', () => {
    const r = 'C-004 PATEL: NEEDS REVIEW — partial match only'
    const events = detectVerdicts(r)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('review')
    expect(events[0].marker).toBe('C-004:REVIEW')
  })

  it('emits multiple verdicts when reasoning enumerates several', () => {
    const r = 'Ledger: C-001 POSITIVE MATCH, C-002 CLEARED, C-003 NEEDS REVIEW'
    const events = detectVerdicts(r)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.marker)).toEqual([
      'C-001:POSITIVE',
      'C-002:CLEARED',
      'C-003:REVIEW',
    ])
  })

  it('falls back to single bare verdict without customer id', () => {
    const r = 'The result is a POSITIVE MATCH'
    const events = detectVerdicts(r)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('positive')
    expect(events[0].marker).toBe('POSITIVE')
  })

  it('returns empty for reasoning without any verdict markers', () => {
    expect(detectVerdicts('clicking button')).toEqual([])
    expect(detectVerdicts(undefined)).toEqual([])
    expect(detectVerdicts('')).toEqual([])
  })

  it('truncates overly-long verdict snippets', () => {
    const r = `C-005 AL-ASSAD: POSITIVE MATCH — ${'detail '.repeat(40)}`
    const events = detectVerdicts(r)
    expect(events[0].text.length).toBeLessThanOrEqual(80)
  })
})

describe('VerdictTracker', () => {
  it('emits each verdict exactly once across calls', () => {
    const tracker = new VerdictTracker()
    const turn1 = tracker.accept('C-001 POSITIVE MATCH — Russia')
    expect(turn1).toHaveLength(1)
    expect(turn1[0].marker).toBe('C-001:POSITIVE')
    // Next turn: agent's ledger reasoning repeats C-001 as a completed item.
    // Should NOT re-emit it; we only want the badge once per session.
    const turn2 = tracker.accept('Done=[C-001]. Current=C-002.')
    expect(turn2).toHaveLength(0)
  })

  it('emits new verdicts while suppressing old ones', () => {
    const tracker = new VerdictTracker()
    tracker.accept('C-001 POSITIVE MATCH')
    tracker.accept('C-001 POSITIVE MATCH. Now looking at C-002.')
    const fresh = tracker.accept('C-001 POSITIVE MATCH, C-002 CLEARED')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].marker).toBe('C-002:CLEARED')
  })

  it('reset() re-enables verdicts already seen', () => {
    const tracker = new VerdictTracker()
    tracker.accept('C-001 POSITIVE MATCH')
    expect(tracker.accept('C-001 POSITIVE MATCH')).toHaveLength(0)
    tracker.reset()
    expect(tracker.accept('C-001 POSITIVE MATCH')).toHaveLength(1)
  })
})

describe('buildProgressLabel', () => {
  it('combines turn + ledger marker when present', () => {
    expect(buildProgressLabel(27, 150, 'C-003')).toBe('Turn 27 · C-003')
  })

  it('falls back to Turn N / max when no marker', () => {
    expect(buildProgressLabel(5, 65)).toBe('Turn 5 / 65')
    expect(buildProgressLabel(5, 65, undefined)).toBe('Turn 5 / 65')
  })
})
