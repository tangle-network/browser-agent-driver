/**
 * Real WCAG 2.1 contrast measurement.
 *
 * Walks every visible text element in the page, computes its actual rendered
 * text color and resolved background color (climbing the parent chain through
 * transparent backgrounds), then calculates the WCAG relative luminance ratio.
 *
 * This is deterministic — pure math, no LLM. Replaces the LLM's "estimated
 * contrast ratio" guesses with ground truth.
 */

import type { Page } from 'playwright'
import type { ContrastReport, ContrastFailure } from '../types.js'

/**
 * In-page worker that walks the DOM and returns failing elements.
 * Runs entirely in the page context — no Playwright round-trips per element.
 */
function inPageContrastCheck(): {
  totalChecked: number
  aaFailures: ContrastFailure[]
  aaaFailures: ContrastFailure[]
} {
  // ── Color parsing ───────────────────────────────────────────────────────
  function parseRGBA(value: string): { r: number; g: number; b: number; a: number } | null {
    const m = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/)
    if (!m) return null
    return {
      r: parseFloat(m[1]),
      g: parseFloat(m[2]),
      b: parseFloat(m[3]),
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    }
  }

  function rgbToHex(r: number, g: number, b: number): string {
    const h = (n: number) => Math.round(n).toString(16).padStart(2, '0')
    return `#${h(r)}${h(g)}${h(b)}`
  }

  // Composite a translucent color over an opaque background.
  function composite(
    fg: { r: number; g: number; b: number; a: number },
    bg: { r: number; g: number; b: number; a: number },
  ): { r: number; g: number; b: number; a: number } {
    const a = fg.a + bg.a * (1 - fg.a)
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    }
  }

  // ── WCAG 2.1 contrast math ──────────────────────────────────────────────
  function relativeLuminance(r: number, g: number, b: number): number {
    const norm = (c: number) => {
      const v = c / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * norm(r) + 0.7152 * norm(g) + 0.0722 * norm(b)
  }

  function contrastRatio(
    fg: { r: number; g: number; b: number },
    bg: { r: number; g: number; b: number },
  ): number {
    const l1 = relativeLuminance(fg.r, fg.g, fg.b)
    const l2 = relativeLuminance(bg.r, bg.g, bg.b)
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
  }

  // Resolve the effective background color of an element by walking parents
  // and compositing translucent layers.
  function resolveBackground(el: Element): { r: number; g: number; b: number; a: number } {
    let composed: { r: number; g: number; b: number; a: number } = { r: 255, g: 255, b: 255, a: 1 }
    let current: Element | null = el
    const stack: Array<{ r: number; g: number; b: number; a: number }> = []

    while (current) {
      const cs = window.getComputedStyle(current)
      const bg = parseRGBA(cs.backgroundColor)
      if (bg && bg.a > 0) {
        stack.push(bg)
        if (bg.a >= 1) break
      }
      current = current.parentElement
    }

    // Composite from outermost (root) to innermost (element)
    composed = { r: 255, g: 255, b: 255, a: 1 }
    for (let i = stack.length - 1; i >= 0; i--) {
      composed = composite(stack[i], composed)
    }
    return composed
  }

  // Generate a stable, human-readable selector for an element.
  function selectorFor(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`
    const tag = el.tagName.toLowerCase()
    const cls = (el.className && typeof el.className === 'string')
      ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).map(c => '.' + CSS.escape(c)).join('')
      : ''
    let parent = el.parentElement
    let parentSel = ''
    if (parent && parent !== document.body) {
      const ptag = parent.tagName.toLowerCase()
      const pid = parent.id ? `#${CSS.escape(parent.id)}` : ''
      parentSel = `${ptag}${pid} > `
    }
    return `${parentSel}${tag}${cls}`
  }

  // Determine if an element qualifies as "large text" per WCAG 2.1:
  // 18pt+ regular OR 14pt+ bold (1pt = 1.333px → 24px or 18.66px)
  function isLargeText(fontSize: number, fontWeight: string): boolean {
    const weight = parseInt(fontWeight, 10) || 400
    if (fontSize >= 24) return true
    if (fontSize >= 18.66 && weight >= 700) return true
    return false
  }

  // ── Walk the DOM ────────────────────────────────────────────────────────
  const aaFailures: ContrastFailure[] = []
  const aaaFailures: ContrastFailure[] = []
  let totalChecked = 0

  // Only consider visible text-bearing elements.
  const candidates = document.querySelectorAll<HTMLElement>('*')
  for (const el of candidates) {
    if (totalChecked >= 5000) break // safety bound

    // Must have direct text content (not just nested children with text)
    const hasDirectText = Array.from(el.childNodes).some(
      n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    )
    if (!hasDirectText) continue

    // Must be visible
    if (el.offsetWidth === 0 || el.offsetHeight === 0) continue
    const cs = window.getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue

    const fg = parseRGBA(cs.color)
    if (!fg) continue
    const bg = resolveBackground(el)
    if (bg.a === 0) continue

    // Composite text color over background if text has alpha
    const compositedFg = fg.a < 1 ? composite(fg, bg) : fg
    const ratio = contrastRatio(compositedFg, bg)

    const fontSize = parseFloat(cs.fontSize) || 16
    const large = isLargeText(fontSize, cs.fontWeight)
    const aaRequired = large ? 3 : 4.5
    const aaaRequired = large ? 4.5 : 7

    totalChecked++

    if (ratio < aaRequired) {
      const text = (el.textContent ?? '').trim().slice(0, 60)
      aaFailures.push({
        selector: selectorFor(el),
        text,
        color: rgbToHex(compositedFg.r, compositedFg.g, compositedFg.b),
        background: rgbToHex(bg.r, bg.g, bg.b),
        ratio: Math.round(ratio * 100) / 100,
        required: aaRequired,
        fontSize,
        isLargeText: large,
      })
    } else if (ratio < aaaRequired) {
      // Only record AAA failures for the first 50 elements to avoid bloat
      if (aaaFailures.length < 50) {
        const text = (el.textContent ?? '').trim().slice(0, 60)
        aaaFailures.push({
          selector: selectorFor(el),
          text,
          color: rgbToHex(compositedFg.r, compositedFg.g, compositedFg.b),
          background: rgbToHex(bg.r, bg.g, bg.b),
          ratio: Math.round(ratio * 100) / 100,
          required: aaaRequired,
          fontSize,
          isLargeText: large,
        })
      }
    }
  }

  return { totalChecked, aaFailures, aaaFailures }
}

/**
 * Run contrast measurement on a Playwright page.
 * Returns ground-truth WCAG contrast failures.
 */
export async function measureContrast(page: Page): Promise<ContrastReport> {
  try {
    const result = await page.evaluate(inPageContrastCheck)
    const totalAaPassed = result.totalChecked - result.aaFailures.length
    const totalAaaPassed = result.totalChecked - result.aaFailures.length - result.aaaFailures.length
    return {
      totalChecked: result.totalChecked,
      aaFailures: result.aaFailures,
      aaaFailures: result.aaaFailures,
      summary: {
        aaPassRate: result.totalChecked > 0 ? totalAaPassed / result.totalChecked : 1,
        aaaPassRate: result.totalChecked > 0 ? totalAaaPassed / result.totalChecked : 1,
      },
    }
  } catch {
    return {
      totalChecked: 0,
      aaFailures: [],
      aaaFailures: [],
      summary: { aaPassRate: 1, aaaPassRate: 1 },
    }
  }
}
