import { describe, it, expect } from 'vitest'

/**
 * Tests for deduplicateSnapshot logic (src/brain/index.ts, ~line 1106).
 *
 * The function is module-private so we replicate its implementation here
 * to unit-test the algorithm. If the source changes, these tests should
 * be updated to match.
 */

// ---- Replicated from src/brain/index.ts (deduplicateSnapshot) ----

function deduplicateSnapshot(snapshot: string): string {
  const lines = snapshot.split('\n')
  const out: string[] = []

  const parseLine = (line: string) => {
    const m = line.match(/^(\s*-\s+)(\w+)\s+"([^"]*)"\s*\[ref=(\w+)\]/)
    if (!m) return null
    return { indent: m[1], role: m[2], name: m[3], ref: m[4], full: line }
  }

  const nameStem = (name: string): string =>
    name.replace(/\d+/g, '#')

  let i = 0
  while (i < lines.length) {
    const parsed = parseLine(lines[i])

    if (!parsed || /\b(?:dialog|alertdialog)\b/i.test(parsed.role)) {
      out.push(lines[i])
      i++
      continue
    }

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
      for (const g of group) out.push(g.full)
    } else {
      const last = group[group.length - 1]
      out.push(`${parsed.full} (+${group.length - 1} similar: "${group[1].name}"\u2026"${last.name}")`)
    }
    i = j
  }

  return out.join('\n')
}

// ---- Tests ----

describe('deduplicateSnapshot', () => {
  it('collapses 20 identical-role links into 1 line with count', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `- link "Page ${i + 1}" [ref=r${i + 1}]`
    )
    const input = lines.join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(1)
    expect(resultLines[0]).toContain('link "Page 1"')
    expect(resultLines[0]).toContain('+19 similar')
    expect(resultLines[0]).toContain('"Page 2"')
    expect(resultLines[0]).toContain('"Page 20"')
  })

  it('does NOT collapse when only 2 similar items exist (threshold is 3)', () => {
    const input = [
      '- link "Page 1" [ref=r1]',
      '- link "Page 2" [ref=r2]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(2)
    expect(resultLines[0]).toBe('- link "Page 1" [ref=r1]')
    expect(resultLines[1]).toBe('- link "Page 2" [ref=r2]')
  })

  it('never collapses dialog elements even with 3+ similar ones', () => {
    const input = [
      '- dialog "Alert 1" [ref=d1]',
      '- dialog "Alert 2" [ref=d2]',
      '- dialog "Alert 3" [ref=d3]',
      '- dialog "Alert 4" [ref=d4]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(4)
    expect(resultLines[0]).toBe('- dialog "Alert 1" [ref=d1]')
    expect(resultLines[1]).toBe('- dialog "Alert 2" [ref=d2]')
    expect(resultLines[2]).toBe('- dialog "Alert 3" [ref=d3]')
    expect(resultLines[3]).toBe('- dialog "Alert 4" [ref=d4]')
  })

  it('never collapses alertdialog elements even with 3+ similar ones', () => {
    const input = [
      '- alertdialog "Warning 1" [ref=a1]',
      '- alertdialog "Warning 2" [ref=a2]',
      '- alertdialog "Warning 3" [ref=a3]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(3)
    expect(resultLines[0]).toBe('- alertdialog "Warning 1" [ref=a1]')
    expect(resultLines[1]).toBe('- alertdialog "Warning 2" [ref=a2]')
    expect(resultLines[2]).toBe('- alertdialog "Warning 3" [ref=a3]')
  })

  it('handles mixed content: collapses links but preserves buttons and dialogs', () => {
    const input = [
      '- button "Submit" [ref=b1]',
      '- link "Page 1" [ref=r1]',
      '- link "Page 2" [ref=r2]',
      '- link "Page 3" [ref=r3]',
      '- link "Page 4" [ref=r4]',
      '- link "Page 5" [ref=r5]',
      '- dialog "Cookie consent 1" [ref=d1]',
      '- dialog "Cookie consent 2" [ref=d2]',
      '- dialog "Cookie consent 3" [ref=d3]',
      '- button "Cancel" [ref=b2]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    // button "Submit" (standalone, no group)
    // 5 links collapsed to 1 line
    // 3 dialogs preserved individually
    // button "Cancel" (standalone, no group)
    expect(resultLines).toHaveLength(6)
    expect(resultLines[0]).toBe('- button "Submit" [ref=b1]')
    expect(resultLines[1]).toContain('+4 similar')
    expect(resultLines[1]).toContain('link "Page 1"')
    expect(resultLines[2]).toBe('- dialog "Cookie consent 1" [ref=d1]')
    expect(resultLines[3]).toBe('- dialog "Cookie consent 2" [ref=d2]')
    expect(resultLines[4]).toBe('- dialog "Cookie consent 3" [ref=d3]')
    expect(resultLines[5]).toBe('- button "Cancel" [ref=b2]')
  })

  it('output is shorter than input when collapsing 20 links', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `- link "Page ${i + 1}" [ref=r${i + 1}]`
    )
    const input = lines.join('\n')
    const result = deduplicateSnapshot(input)

    expect(result.length).toBeLessThan(input.length)
  })

  it('collapses exactly 3 items (minimum threshold)', () => {
    const input = [
      '- link "Item 1" [ref=r1]',
      '- link "Item 2" [ref=r2]',
      '- link "Item 3" [ref=r3]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(1)
    expect(resultLines[0]).toContain('+2 similar')
    expect(resultLines[0]).toContain('"Item 2"')
    expect(resultLines[0]).toContain('"Item 3"')
  })

  it('preserves non-element lines (no role/ref pattern)', () => {
    const input = [
      'Some heading text',
      '- link "Nav 1" [ref=n1]',
      '- link "Nav 2" [ref=n2]',
      '- link "Nav 3" [ref=n3]',
      '- link "Nav 4" [ref=n4]',
      'Footer text',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines[0]).toBe('Some heading text')
    expect(resultLines[1]).toContain('+3 similar')
    expect(resultLines[2]).toBe('Footer text')
    expect(resultLines).toHaveLength(3)
  })

  it('does not group items with different roles', () => {
    const input = [
      '- link "Item 1" [ref=r1]',
      '- button "Item 2" [ref=r2]',
      '- link "Item 3" [ref=r3]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    // None form a consecutive group of 3 with same role
    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(3)
  })

  it('does not group items with different indentation', () => {
    const input = [
      '- link "Page 1" [ref=r1]',
      '  - link "Page 2" [ref=r2]',
      '- link "Page 3" [ref=r3]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    expect(resultLines).toHaveLength(3)
  })

  it('handles empty input', () => {
    expect(deduplicateSnapshot('')).toBe('')
  })

  it('handles input with no collapsible elements', () => {
    const input = [
      '- button "Submit" [ref=b1]',
      '- textbox "Email" [ref=t1]',
      '- heading "Welcome" [ref=h1]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    expect(result).toBe(input)
  })

  it('collapses multiple separate groups independently', () => {
    const input = [
      '- link "Page 1" [ref=p1]',
      '- link "Page 2" [ref=p2]',
      '- link "Page 3" [ref=p3]',
      '- button "Submit" [ref=b1]',
      '- link "Category 1" [ref=c1]',
      '- link "Category 2" [ref=c2]',
      '- link "Category 3" [ref=c3]',
      '- link "Category 4" [ref=c4]',
    ].join('\n')
    const result = deduplicateSnapshot(input)

    const resultLines = result.split('\n')
    // Group 1: 3 "Page" links → 1 collapsed line
    // Standalone button
    // Group 2: 4 "Category" links → 1 collapsed line
    expect(resultLines).toHaveLength(3)
    expect(resultLines[0]).toContain('+2 similar')
    expect(resultLines[0]).toContain('Page 1')
    expect(resultLines[1]).toBe('- button "Submit" [ref=b1]')
    expect(resultLines[2]).toContain('+3 similar')
    expect(resultLines[2]).toContain('Category 1')
  })
})
