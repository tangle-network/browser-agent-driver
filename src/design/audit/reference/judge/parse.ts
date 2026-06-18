/**
 * Judge-response parsing — the PURE parse core. Turns one model response into a
 * slot-relative `RawVerdict`. Fail-closed by contract: any unparseable or
 * winner-less response collapses to a `tie` with confidence 0 and an explicit
 * reason, never a fabricated A/B verdict. Slot bias is only neutralisable if a
 * garbage response counts as "no signal", so this NEVER guesses a winner.
 *
 * It is deliberately tolerant of the noise real gateways add (markdown fences,
 * prose preambles around the object) — mirroring `brain.parse` — but it is
 * strict about the one field that matters: the winner must be an unambiguous
 * A / B / tie token, or the verdict is a tie.
 */

import type { RawVerdict } from '../contracts.js'

const DEFAULT_CONFIDENCE = 0.5

function stripFences(raw: string): string {
  let t = raw.trim()
  if (t.startsWith('```')) {
    t = t
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim()
  }
  return t
}

function extractObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    // Some gateways wrap the object in prose ("Here's the verdict: {…}"); fall
    // back to the outermost brace pair before giving up.
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeWinner(raw: unknown): RawVerdict['winnerSlot'] | null {
  if (typeof raw !== 'string') return null
  const w = raw.trim().toUpperCase()
  if (w === 'A') return 'A'
  if (w === 'B') return 'B'
  if (w === 'TIE' || w === 'DRAW' || w === 'EQUAL' || w === 'NEITHER' || w === 'NONE') return 'tie'
  return null
}

function normalizeConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN
  if (!Number.isFinite(n)) return DEFAULT_CONFIDENCE
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function normalizeReasons(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim())
  }
  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()]
  return []
}

/**
 * Parse a judge response into a slot-relative `RawVerdict`. Garbage in →
 * `{ winnerSlot: 'tie', confidence: 0, reasons: [<why>] }`.
 */
export function parseRawVerdict(raw: string): RawVerdict {
  const obj = extractObject(stripFences(raw))
  if (!obj) {
    return { winnerSlot: 'tie', confidence: 0, reasons: ['unparseable judge response'] }
  }
  const winnerSlot = normalizeWinner(obj.winner ?? obj.winnerSlot ?? obj.choice)
  if (!winnerSlot) {
    return { winnerSlot: 'tie', confidence: 0, reasons: ['judge response missing a valid winner'] }
  }
  return {
    winnerSlot,
    confidence: normalizeConfidence(obj.confidence),
    reasons: normalizeReasons(obj.reasons ?? obj.reason),
  }
}
