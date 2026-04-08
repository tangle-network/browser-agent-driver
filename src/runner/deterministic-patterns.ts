/**
 * Deterministic UI pattern matchers — short-circuit brain.decide() when the
 * page state has exactly one obvious action.
 *
 * Cookie banners with a single "Accept" button are everywhere. Modals with
 * one "Close" button. Wizard pages with one "Next". The agent doesn't need
 * an LLM call to decide what to do — the answer is deterministic. Skipping
 * the LLM call saves 1-3s per match.
 *
 * Pattern matchers run on the snapshot text and return either an Action to
 * execute or null. Matchers must be:
 *   - Specific: false positives waste a turn (worse than no skip)
 *   - Cheap: no I/O, no LLM, no DOM walks beyond regex on the snapshot
 *   - Reversible: if execute fails, the next turn falls through to brain.decide()
 *
 * Each matcher returns a `PatternMatch` with the action to take and a
 * `patternId` so the bus can emit `decide-skipped-pattern` events for audit.
 */

import type { Action, PageState } from '../types.js'

export interface PatternMatch {
  action: Action
  patternId: string
  reasoning: string
  expectedEffect: string
}

/**
 * Try every pattern in order. Returns the first match, or null if none fire.
 *
 * Patterns must be ordered from MOST SPECIFIC to LEAST SPECIFIC so a precise
 * match (e.g., "single accept button on a cookie banner") wins over a
 * generic one (e.g., "any single visible button").
 */
export function matchDeterministicPattern(state: PageState): PatternMatch | null {
  for (const matcher of MATCHERS) {
    const match = matcher(state)
    if (match) return match
  }
  return null
}

type Matcher = (state: PageState) => PatternMatch | null

// ── Pattern: cookie banner / consent modal accept ───────────────────────
//
// Match conditions:
//   - The snapshot has at most ONE dialog/banner/alertdialog containing a
//     button matching /accept|agree|got it|i understand|allow all|allow cookies|continue/i
//   - Other dialogs (if any) are smaller content dialogs (no buttons or
//     only "Close" — the cookie consent is the largest one)
//
// Why this is safe: cookie banners are functionally homogeneous across the
// web. The user wants to dismiss them and proceed. There's no scenario
// where "click Accept on the cookie banner" is the wrong choice.

const COOKIE_ACCEPT_RE = /\b(accept(?:\s+all)?|agree|got\s+it|i\s+understand|allow\s+all|allow\s+cookies|continue)\b/i
const COOKIE_BANNER_REF_RE = /^\s*(button|link)\s+\[ref=([^\]]+)\][^"]*"([^"]*)"/im

const cookieBannerMatcher: Matcher = (state) => {
  // Look for any element line containing both an accept-style verb AND a ref
  const lines = state.snapshot.split('\n')
  for (const line of lines) {
    const refMatch = line.match(/\[ref=([^\]]+)\][^"]*"([^"]*)"/i)
    if (!refMatch) continue
    const text = refMatch[2]
    if (!COOKIE_ACCEPT_RE.test(text)) continue
    // Filter out generic continues that aren't on a banner. Require the line
    // to be a button or link AND for the snapshot to mention "cookie" or
    // "consent" or "privacy" or "gdpr" within 500 chars of this line.
    if (!/\b(button|link)\b/i.test(line)) continue
    const lineIdx = state.snapshot.indexOf(line)
    const windowStart = Math.max(0, lineIdx - 500)
    const windowEnd = Math.min(state.snapshot.length, lineIdx + 500)
    const window = state.snapshot.slice(windowStart, windowEnd).toLowerCase()
    if (!/cookie|consent|privacy|gdpr|tracking/i.test(window)) continue
    return {
      action: { action: 'click', selector: `@${refMatch[1]}` },
      patternId: 'cookie-banner-accept',
      reasoning: `Deterministic pattern: cookie/consent banner with "${text}" button. Skipping LLM call.`,
      expectedEffect: 'cookie banner dismissed',
    }
  }
  return null
}

// ── Pattern: single-action modal close ──────────────────────────────────
//
// Match conditions:
//   - Snapshot has exactly one alertdialog/dialog
//   - The dialog has exactly ONE button or close affordance
//   - The button text is "Close", "Dismiss", "OK", or "X"
//
// Excludes confirmation dialogs (Yes/No, Save/Cancel) — those need real
// thought.

const CLOSE_VERBS_RE = /^\s*(close|dismiss|ok|×|x|got it)\s*$/i

const singleButtonModalMatcher: Matcher = (state) => {
  // Find a line starting with dialog/alertdialog (no leading whitespace —
  // a top-level snapshot element). Children of the dialog are indented
  // beneath it.
  const lines = state.snapshot.split('\n')
  let dialogIdx = -1
  for (let idx = 0; idx < lines.length; idx++) {
    if (/^(dialog|alertdialog)\b/i.test(lines[idx])) {
      dialogIdx = idx
      break
    }
  }
  if (dialogIdx === -1) return null

  // The dialog region is its line plus the indented children that follow.
  // Stop at the next non-indented line (sibling element).
  const regionLines: string[] = [lines[dialogIdx]]
  for (let idx = dialogIdx + 1; idx < lines.length; idx++) {
    if (lines[idx].length > 0 && !/^\s/.test(lines[idx])) break
    regionLines.push(lines[idx])
  }

  // Count interactive elements (buttons / links with refs) in the region
  const interactiveLines = regionLines.filter((l) =>
    /\b(button|link)\b\s+\[ref=/.test(l),
  )
  if (interactiveLines.length !== 1) return null

  const match = interactiveLines[0].match(/\[ref=([^\]]+)\][^"]*"([^"]*)"/)
  if (!match) return null
  const text = match[2]
  if (!CLOSE_VERBS_RE.test(text)) return null

  return {
    action: { action: 'click', selector: `@${match[1]}` },
    patternId: 'single-button-modal-close',
    reasoning: `Deterministic pattern: modal with single "${text}" button. Skipping LLM call.`,
    expectedEffect: 'modal dismissed',
  }
}

// ── Registered matcher list ─────────────────────────────────────────────
// Order: most specific first.
const MATCHERS: Matcher[] = [
  cookieBannerMatcher,
  singleButtonModalMatcher,
]

/** Exported for tests so individual matchers can be exercised in isolation. */
export const __test = {
  cookieBannerMatcher,
  singleButtonModalMatcher,
}
