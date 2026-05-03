/**
 * Agent narration hooks for the cursor overlay.
 *
 * The runner emits `decide-completed` each turn with the LLM's raw
 * reasoning text. That text carries three distinct signals the overlay
 * wants to surface to a viewer:
 *
 *   1. **Current step** — a short phrase summarizing what the agent is
 *      about to do. Extracted from the first sentence of `reasoning`.
 *   2. **Progress** — turn N of maxTurns, plus any inline progress
 *      ledger (`Done=[C-001, C-002, ...] Current=C-003`) the agent is
 *      already using in OFAC/batch-style prompts.
 *   3. **Verdict moments** — conclusions like "POSITIVE MATCH",
 *      "CLEARED", "NEEDS REVIEW" that should fire a celebratory badge.
 *
 * These are pure functions — no I/O, no driver calls. The driver-facing
 * hooks in runner.ts call them, then push results via
 * `driver.setOverlayReasoning` / `setOverlayProgress` / `pushOverlayBadge`.
 *
 * Why a separate module: the runner is already 1500+ lines and dense;
 * parsing logic belongs somewhere testable in isolation. Keeping this
 * pure makes the overlay story auditable without standing up a browser.
 */

const VERDICT_PATTERNS: { re: RegExp; kind: 'positive' | 'cleared' | 'review' }[] = [
  { re: /\bPOSITIVE\s+MATCH\b/i, kind: 'positive' },
  { re: /\bCLEARED\b/i, kind: 'cleared' },
  { re: /\bNEEDS\s+REVIEW\b/i, kind: 'review' },
]

/**
 * Pull the first sentence (or first ~140 chars) of reasoning as a
 * display summary. The reasoning panel renders the full text; this is a
 * hook for callers that want a preview (e.g., badge text).
 */
export function summarizeReasoning(reasoning: string | undefined): string {
  if (!reasoning) return ''
  const collapsed = reasoning.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  // Cut at sentence boundary if short; otherwise hard-truncate.
  const firstSentence = collapsed.match(/^(.+?[.!?])\s/)
  if (firstSentence && firstSentence[1].length <= 180) return firstSentence[1]
  return collapsed.length > 180 ? collapsed.slice(0, 177).trimEnd() + '…' : collapsed
}

/**
 * Parse a "Current=C-XXX" marker from the reasoning, if present. Used to
 * enrich the progress label ("Turn 27 · C-003"). Returns undefined when
 * the reasoning doesn't carry a ledger marker — NOT every run uses the
 * ledger shape.
 */
export function extractCurrentMarker(reasoning: string | undefined): string | undefined {
  if (!reasoning) return undefined
  const m = reasoning.match(/Current\s*=\s*([A-Za-z0-9][\w-]*)/)
  if (m) return m[1]
  return undefined
}

/**
 * Parse a "Done=[...]" ledger from reasoning. Returns the count of
 * completed items, or undefined when no ledger exists. Used to compute
 * a second progress indicator (items done vs items total) orthogonal to
 * turn-of-maxTurns.
 */
export function extractDoneCount(reasoning: string | undefined): number | undefined {
  if (!reasoning) return undefined
  const m = reasoning.match(/Done\s*=\s*\[([^\]]*)\]/)
  if (!m) return undefined
  const body = m[1].trim()
  if (!body) return 0
  // Count comma-separated entries, tolerate trailing commas
  return body.split(',').filter((s) => s.trim().length > 0).length
}

export interface VerdictEvent {
  kind: 'positive' | 'cleared' | 'review'
  text: string
  /** Raw verdict substring so we can dedupe later in the session */
  marker: string
}

/**
 * Scan reasoning + action text for new verdict-worthy moments. Returns
 * an array (possibly empty) of events the driver should surface as
 * badges. The caller is responsible for deduplication across turns —
 * this function returns ALL verdict markers visible in the text.
 *
 * For a reasoning string like:
 *   "C-003 PUTIN VLADIMIR: POSITIVE MATCH — Russia-EO14024 / SDN"
 * emits: { kind: 'positive', text: 'C-003 PUTIN VLADIMIR · POSITIVE MATCH', marker: 'C-003:POSITIVE MATCH' }
 */
export function detectVerdicts(reasoning: string | undefined): VerdictEvent[] {
  if (!reasoning) return []
  const out: VerdictEvent[] = []
  // Case: inline customer-ID prefix (OFAC-style)
  //   "C-003 confirmed POSITIVE MATCH" / "C-003: CLEARED"
  // Trailer is comma-bounded so enumerations like
  //   "C-001 POSITIVE MATCH, C-002 CLEARED, C-003 NEEDS REVIEW"
  // yield one event per customer, not one event for the whole line.
  const inlineRe = /\b([A-Z]-\d{3,4})[^\w]{1,6}([^.,\n]*?(?:POSITIVE\s+MATCH|CLEARED|NEEDS\s+REVIEW)[^.,\n]*)/gi
  let m: RegExpExecArray | null
  const seenInText = new Set<string>()
  while ((m = inlineRe.exec(reasoning)) !== null) {
    const cid = m[1]
    const snippet = m[2].replace(/\s+/g, ' ').trim()
    const kind = snippet.match(/POSITIVE/i) ? 'positive' : snippet.match(/CLEARED/i) ? 'cleared' : 'review'
    const marker = `${cid}:${kind.toUpperCase()}`
    // Dedupe within a single reasoning string — agent may restate
    // "C-001 POSITIVE" later in the same line without intending a new event.
    if (seenInText.has(marker)) continue
    seenInText.add(marker)
    const shortSnippet = snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet
    out.push({
      kind,
      text: `${cid} · ${shortSnippet}`,
      marker,
    })
  }
  // Fallback: bare verdict without customer ID. Only emit ONE per reasoning
  // string in this mode (multiple would be noise without context).
  if (out.length === 0) {
    for (const pat of VERDICT_PATTERNS) {
      const vm = reasoning.match(pat.re)
      if (vm) {
        out.push({
          kind: pat.kind,
          text: vm[0].replace(/\s+/g, ' ').trim().toUpperCase(),
          marker: pat.kind.toUpperCase(),
        })
        break
      }
    }
  }
  return out
}

/**
 * Stateful tracker that holds the set of verdict markers already
 * surfaced this session, so we don't re-emit the same badge every turn
 * for a verdict the agent keeps mentioning in its progress ledger.
 */
export class VerdictTracker {
  private seen = new Set<string>()

  /**
   * Given new reasoning text, return only the verdicts that are NEW
   * (haven't been emitted before in this session).
   */
  accept(reasoning: string | undefined): VerdictEvent[] {
    const found = detectVerdicts(reasoning)
    const fresh: VerdictEvent[] = []
    for (const v of found) {
      if (this.seen.has(v.marker)) continue
      this.seen.add(v.marker)
      fresh.push(v)
    }
    return fresh
  }

  reset(): void {
    this.seen.clear()
  }
}

/**
 * Build the progress label shown in the top-left chip of the overlay.
 * Combines turn counter with an optional ledger marker.
 *
 *   buildProgressLabel(5, 65) → "Turn 5 · 65 max"
 *   buildProgressLabel(5, 65, 'C-003') → "Turn 5 · C-003"
 */
export function buildProgressLabel(
  turn: number,
  maxTurns: number,
  marker?: string,
): string {
  if (marker) return `Turn ${turn} · ${marker}`
  return `Turn ${turn} / ${maxTurns}`
}
