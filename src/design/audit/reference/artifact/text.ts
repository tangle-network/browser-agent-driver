/**
 * Word-aware truncation shared by the findings summary and the report's redesign
 * brief. Unlike the hard char-cut used for directional finding bodies, this never
 * splits a word: it backs up to the last space before the limit, strips trailing
 * punctuation, and appends a single ellipsis — so the text always ends cleanly.
 *
 * When no space falls inside the kept window (a single token longer than `max`)
 * it degrades to a hard cut: there is no boundary to honour.
 */
export function clipToWord(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  // Guard max<=1: slice(0, max-1) with max=0 is slice(0,-1) (drops last char).
  const slice = max > 1 ? t.slice(0, max - 1) : ''
  const lastSpace = slice.lastIndexOf(' ')
  const head = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).replace(/[\s.,;:!?-]+$/, '')
  return `${head}…`
}
