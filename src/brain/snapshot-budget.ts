/**
 * Snapshot budgeting: dedup repeated element runs, cap total size while
 * preserving interactive + content lines, and compact the first-turn snapshot.
 *
 * Pure functions over snapshot text — no Brain state.
 */

import { AriaSnapshotHelper } from '../drivers/snapshot.js';

/**
 * Collapse consecutive runs of similar elements (same indent + role, names
 * differing only by a trailing number/short suffix) into a single representative
 * line with a count.  Reduces token cost on pages with long pagination, nav
 * lists, or repeated product cards.
 *
 * Skips dialog/alertdialog (agent must see each one) and groups < 3 items.
 */
function deduplicateSnapshot(snapshot: string): string {
  const lines = snapshot.split('\n')
  const out: string[] = []

  // Extract (indent, role) from a snapshot line. Returns null for non-element lines.
  const parseLine = (line: string) => {
    const m = line.match(/^(\s*-\s+)(\w+)\s+"([^"]*)"\s*\[ref=(\w+)\]/)
    if (!m) return null
    return { indent: m[1], role: m[2], name: m[3], ref: m[4], full: line }
  }

  // Strip trailing numbers/ordinals to get a "name stem" for grouping.
  // "Page 1" and "Page 20" → "Page ", "Item #3" and "Item #42" → "Item #"
  const nameStem = (name: string): string =>
    name.replace(/\d+/g, '#')

  // Structural fingerprint for a block of lines (element + its children).
  // Used for card-level dedup: two hotel cards have different names but the
  // same structure (listitem > link + img + text + text + button).
  const structuralFingerprint = (startIdx: number, baseIndent: string): { fp: string; endIdx: number } => {
    const roles: string[] = []
    let j = startIdx
    while (j < lines.length) {
      const p = parseLine(lines[j])
      if (!p) { j++; continue }
      // Stop when we hit an element at the same or shallower indent (sibling or parent)
      if (j > startIdx && p.indent.length <= baseIndent.length) break
      roles.push(p.role)
      j++
    }
    return { fp: roles.join(','), endIdx: j }
  }

  let i = 0
  while (i < lines.length) {
    const parsed = parseLine(lines[i])

    // Non-element line or dialog/alertdialog — emit as-is
    if (!parsed || /\b(?:dialog|alertdialog)\b/i.test(parsed.role)) {
      out.push(lines[i])
      i++
      continue
    }

    // Try block-level dedup first: look for consecutive sibling blocks
    // with the same structural fingerprint (same child-role sequence).
    // This catches card patterns like Booking hotel results, Allrecipes cards.
    if (/\b(?:listitem|article|group|region)\b/i.test(parsed.role)) {
      const { fp: firstFp, endIdx: firstEnd } = structuralFingerprint(i, parsed.indent)
      if (firstEnd > i + 2 && firstFp.includes(',')) { // non-trivial block
        const blocks: Array<{ start: number; end: number; firstLine: string }> = [
          { start: i, end: firstEnd, firstLine: lines[i] },
        ]
        let scanIdx = firstEnd
        while (scanIdx < lines.length) {
          const nextParsed = parseLine(lines[scanIdx])
          if (!nextParsed || nextParsed.indent !== parsed.indent || nextParsed.role !== parsed.role) break
          const { fp: nextFp, endIdx: nextEnd } = structuralFingerprint(scanIdx, nextParsed.indent)
          if (nextFp !== firstFp) break
          blocks.push({ start: scanIdx, end: nextEnd, firstLine: lines[scanIdx] })
          scanIdx = nextEnd
        }

        if (blocks.length >= 3) {
          // Emit first 2 blocks fully, summarize the rest
          for (let b = 0; b < Math.min(2, blocks.length); b++) {
            for (let k = blocks[b].start; k < blocks[b].end; k++) {
              out.push(lines[k])
            }
          }
          const remaining = blocks.length - 2
          out.push(`${parsed.indent}... [${remaining} more similar ${parsed.role} blocks with same structure]`)
          i = blocks[blocks.length - 1].end
          continue
        }
      }
    }

    // Line-level dedup: consecutive runs of same (indent, role, name stem)
    const group: NonNullable<ReturnType<typeof parseLine>>[] = [parsed]
    const stem = nameStem(parsed.name)
    let j = i + 1
    while (j < lines.length) {
      const next = parseLine(lines[j])
      if (
        !next ||
        next.indent !== parsed.indent ||
        next.role !== parsed.role ||
        nameStem(next.name) !== stem
      ) break
      group.push(next)
      j++
    }

    if (group.length < 3) {
      // Not enough to dedup — emit originals
      for (const g of group) out.push(g.full)
    } else {
      // Emit first element with a summary of the rest
      const last = group[group.length - 1]
      out.push(`${parsed.full} (+${group.length - 1} similar: "${group[1].name}"\u2026"${last.name}")`)
    }
    i = j
  }

  return out.join('\n')
}

/**
 * Cap snapshot size to control token cost on large pages.
 * Keeps the full snapshot when it fits within budget; otherwise preserves:
 *   1. Interactive elements with refs (buttons, inputs, links — for action targets)
 *   2. Content lines: term/definition/code/pre/paragraph (for extraction tasks
 *      like MDN, Python docs, W3C spec where the value the agent needs lives in
 *      a `<dl>/<code>/<pre>` block, not in an interactive element)
 *
 * New-page callers use a larger default budget; same-page callers can pass a
 * tighter budget after the model has already seen the full snapshot once.
 */
export function budgetSnapshot(snapshot: string, maxChars = 24_000): string {
  // Skip dedup on small snapshots — not enough repetition to justify the O(n) scan
  if (snapshot.length > 6_000) {
    snapshot = deduplicateSnapshot(snapshot)
  }

  if (snapshot.length <= maxChars) return snapshot;

  // First pass: separate keep-set (interactive + content lines) from decorative.
  // Content roles (term, definition, code, pre, paragraph) carry text the LLM
  // needs for extraction tasks. They have no [ref=] but the text is the data.
  const lines = snapshot.split('\n');
  const interactive: string[] = [];
  const content: string[] = [];
  const decorative: string[] = [];
  for (const line of lines) {
    if (/\b(?:button|link|textbox|combobox|menuitem|checkbox|radio|select|heading|dialog|alertdialog)\b/i.test(line) && /\[ref=/.test(line)) {
      interactive.push(line);
    } else if (/^\s*-\s+(?:term|definition|code|pre|paragraph)\b/i.test(line)) {
      content.push(line);
    } else {
      decorative.push(line);
    }
  }

  // If interactive + content fits, use both with a truncation note
  const keepSet = interactive.concat(content);
  const keepText = keepSet.join('\n');
  if (keepText.length <= maxChars) {
    return keepText + `\n... [${decorative.length} decorative elements omitted for brevity]`;
  }

  // Second pass: when interactive + content still exceed budget, prioritize:
  // 1. inputs (searchbox/textbox/combobox) — essential for form tasks
  // 2. headings + dialogs — structural navigation
  // 3. content lines (term/definition/code/pre) — extraction data
  // 4. bulk links/buttons — main content
  const priority: string[] = [];
  const bulk: string[] = [];
  for (const line of interactive) {
    if (/\b(?:searchbox|textbox|combobox|heading|dialog|alertdialog)\b/i.test(line)) {
      priority.push(line);
    } else {
      bulk.push(line);
    }
  }

  // Content lines come right after priority interactive (they're the extraction
  // data) and before bulk links/buttons.
  const priorityWithContent = priority.concat(content);
  const priorityText = priorityWithContent.join('\n');
  const remaining = maxChars - priorityText.length - 80; // reserve space for note
  if (remaining > 0) {
    const bulkText = bulk.join('\n');
    const trimmedBulk = bulkText.slice(0, remaining);
    const bulkKept = trimmedBulk.lastIndexOf('\n') > 0
      ? trimmedBulk.slice(0, trimmedBulk.lastIndexOf('\n'))
      : trimmedBulk;
    return priorityText + '\n' + bulkKept +
      `\n... [${interactive.length - priority.length - bulkKept.split('\n').length} interactive + ${decorative.length} decorative elements omitted]`;
  }

  // Hard cap: take the first maxChars of the full snapshot
  return snapshot.slice(0, maxChars) + '\n... [snapshot truncated — large page]';
}

export function compactFirstTurnSnapshot(snapshot: string): string {
  const compact = AriaSnapshotHelper.formatCompact(snapshot);
  const basis = compact.length > 0 ? compact : snapshot;
  const maxChars = 4000;
  if (basis.length <= maxChars) return basis;
  return `${basis.slice(0, maxChars)}\n... [snapshot truncated for first-turn fast path]`;
}
