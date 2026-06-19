import { describe, it, expect } from 'vitest'
import {
  detectRawScrollCapture,
  foldScrollMotion,
  createScrollCapturer,
  type ScrollStepSample,
  type ElementSample,
} from '../src/design/audit/reference/dna/scroll-capture.js'
import type { RawScrollCapture, ScrollCapturePage } from '../src/design/audit/reference/contracts.js'

// ── fixture builders (no browser; pure sampled-step fixtures) ────────────────

// One element's timeline across the scroll stops, aligned to the scrollY list.
interface Frame {
  top: number
  bottom?: number
  opacity?: number
  ty?: number
  scale?: number
  position?: string
}
interface ElementTimeline {
  frames: Frame[]
}

function mkSamples(
  scrollYs: number[],
  viewportHeight: number,
  scrollHeight: number,
  elements: ElementTimeline[],
): ScrollStepSample[] {
  return scrollYs.map((scrollY, step) => {
    const els: ElementSample[] = elements.map((el, i) => {
      const f = el.frames[step]
      return {
        i,
        top: f.top,
        bottom: f.bottom ?? f.top + 100,
        opacity: f.opacity ?? 1,
        ty: f.ty ?? 0,
        scale: f.scale ?? 1,
        position: f.position ?? 'static',
      }
    })
    return { scrollY, viewportHeight, scrollHeight, elements: els }
  })
}

// A rigidly-scrolling element (top decreases by exactly scrollDelta) that fades
// / slides / scales in as it enters the viewport — a reveal, never parallax.
const STOPS = [0, 400, 800, 1600]
const VH = 800
const SCROLL_HEIGHT = 2400

const revealHeavy = mkSamples(STOPS, VH, SCROLL_HEIGHT, [
  // fade: opacity 0 → 1 as it enters
  { frames: [
    { top: 700, opacity: 0 },
    { top: 300, opacity: 1 },
    { top: -100, opacity: 1 },
    { top: -900, opacity: 1 },
  ] },
  // slide-up: translateY 20 → 0
  { frames: [
    { top: 700, ty: 20 },
    { top: 300, ty: 0 },
    { top: -100, ty: 0 },
    { top: -900, ty: 0 },
  ] },
  // scale-in: scale 0.85 → 1
  { frames: [
    { top: 700, scale: 0.85 },
    { top: 300, scale: 1 },
    { top: -100, scale: 1 },
    { top: -900, scale: 1 },
  ] },
])

// Sticky pinned element + a half-rate parallax layer; no reveals.
const stickyParallax = mkSamples([0, 800, 1600], VH, 3000, [
  // sticky: stays pinned near the top while the page scrolls past
  { frames: [
    { top: 50, position: 'sticky' },
    { top: 52, position: 'sticky' },
    { top: 48, position: 'sticky' },
  ] },
  // parallax: moves at half the scroll rate (rate 0.5 → score 0.5)
  { frames: [{ top: 500 }, { top: 100 }, { top: -300 }] },
])

// Page scrolls but nothing animates: rigid elements, no opacity/transform/sticky.
const quiet = mkSamples(STOPS, VH, SCROLL_HEIGHT, [
  { frames: [{ top: 400 }, { top: 0 }, { top: -400 }, { top: -1200 }] },
])

// Page that does not scroll (range below the floor): nothing to observe.
const nonScrolling = mkSamples([0, 0], VH, 820, [
  { frames: [{ top: 100 }, { top: 100 }] },
])

// Mid-transition sampling: the settle window is shorter than the reveal's CSS
// transition, so the FIRST in-view stop catches the element half-way (opacity
// 0.3 / ty 35), and only a LATER stop shows it settled (opacity 1 / ty 0). A
// first-match "after" frame misses these; aggregating extremes catches them.
const MT_STOPS = [0, 900, 1500, 1800]
const MT_VH = 900
const MT_SCROLL_HEIGHT = 3000
const midTransition = mkSamples(MT_STOPS, MT_VH, MT_SCROLL_HEIGHT, [
  // fade caught mid-transition at the first shown stop, settled at the next
  { frames: [
    { top: 1500, bottom: 1800, opacity: 0 },
    { top: 600, bottom: 900, opacity: 0.3 },
    { top: 0, bottom: 300, opacity: 1 },
    { top: -300, bottom: 0, opacity: 1 },
  ] },
  // pure slide caught mid-transition (ty 35) then settled (ty 0); rigid in view
  { frames: [
    { top: 1500, bottom: 1800, ty: 48 },
    { top: 600, bottom: 900, ty: 35 },
    { top: 0, bottom: 300, ty: 0 },
    { top: -300, bottom: 0, ty: 0 },
  ] },
])

// A transformed layer whose viewport top moves at HALF the scroll rate (parallax)
// and momentarily reads ty≈0 while in view must NOT be mis-counted as a slide
// reveal — it never moves rigidly with content.
const parallaxNotSlide = mkSamples([0, 800, 1600, 2400], 800, 3400, [
  { frames: [
    { top: 760, ty: 40 },
    { top: 360, ty: 0 },
    { top: -40, ty: 40 },
    { top: -440, ty: 80 },
  ] },
])

// ── detectRawScrollCapture (pure) ─────────────────────────────────────────────

describe('detectRawScrollCapture', () => {
  it('counts reveals and their kinds on a reveal-heavy page (no false parallax/sticky)', () => {
    const raw = detectRawScrollCapture(revealHeavy)
    expect(raw).toBeDefined()
    expect(raw!.scrollHeightPx).toBe(SCROLL_HEIGHT)
    expect(raw!.viewportHeightPx).toBe(VH)
    expect(raw!.steps).toBe(4)
    expect(raw!.reveals.count).toBe(3)
    expect(raw!.reveals.kinds).toEqual(['fade', 'scale-in', 'slide-up'])
    // rigidly-scrolling reveals must not be mistaken for parallax or sticky
    expect(raw!.stickyCount).toBe(0)
    expect(raw!.parallax).toBe(0)
  })

  it('counts sticky pinning and scores a half-rate parallax layer', () => {
    const raw = detectRawScrollCapture(stickyParallax)
    expect(raw).toBeDefined()
    expect(raw!.stickyCount).toBe(1)
    expect(raw!.parallax).toBe(0.5)
    expect(raw!.reveals.count).toBe(0)
    expect(raw!.reveals.kinds).toEqual([])
  })

  it('returns a zeroed record (not undefined) for a scrolling-but-quiet page', () => {
    const raw = detectRawScrollCapture(quiet)
    expect(raw).toBeDefined()
    expect(raw!.reveals.count).toBe(0)
    expect(raw!.stickyCount).toBe(0)
    expect(raw!.parallax).toBe(0)
  })

  it('returns undefined for a non-scrolling page (nothing to observe)', () => {
    expect(detectRawScrollCapture(nonScrolling)).toBeUndefined()
  })

  it('returns undefined for fewer than two stops', () => {
    expect(detectRawScrollCapture(revealHeavy.slice(0, 1))).toBeUndefined()
  })

  it('is deterministic', () => {
    expect(detectRawScrollCapture(revealHeavy)).toEqual(detectRawScrollCapture(revealHeavy))
  })

  it('catches reveals sampled mid-transition (settled at a later stop, not the first in-view one)', () => {
    const raw = detectRawScrollCapture(midTransition)
    expect(raw).toBeDefined()
    expect(raw!.reveals.count).toBe(2)
    expect(raw!.reveals.kinds).toEqual(['fade', 'slide-up'])
    expect(raw!.parallax).toBe(0)
  })

  it('does not mis-count a non-rigid parallax layer as a slide reveal', () => {
    const raw = detectRawScrollCapture(parallaxNotSlide)
    expect(raw).toBeDefined()
    expect(raw!.reveals.count).toBe(0)
    expect(raw!.parallax).toBe(0.5)
  })
})

// ── foldScrollMotion (pure rollup) ────────────────────────────────────────────

const rawStatic: RawScrollCapture = {
  scrollHeightPx: 1600,
  viewportHeightPx: 800,
  steps: 5,
  reveals: { count: 0, kinds: [] },
  stickyCount: 0,
  parallax: 0,
}
const rawReveals: RawScrollCapture = {
  scrollHeightPx: 4200,
  viewportHeightPx: 800,
  steps: 10,
  reveals: { count: 6, kinds: ['fade', 'slide-up'] },
  stickyCount: 0,
  parallax: 0,
}
const rawStickyParallax: RawScrollCapture = {
  scrollHeightPx: 3000,
  viewportHeightPx: 800,
  steps: 8,
  reveals: { count: 0, kinds: [] },
  stickyCount: 2,
  parallax: 0.6,
}

describe('foldScrollMotion', () => {
  it('derives pageHeightRatio and marks a quiet capture not scroll-driven', () => {
    const dna = foldScrollMotion(rawStatic)
    expect(dna.pageHeightRatio).toBe(2)
    expect(dna.scrollDriven).toBe(false)
    expect(dna.reveals).toEqual({ count: 0, kinds: [] })
  })

  it('marks a reveal-rich page scroll-driven', () => {
    const dna = foldScrollMotion(rawReveals)
    expect(dna.pageHeightRatio).toBe(5.25)
    expect(dna.scrollDriven).toBe(true)
    expect(dna.reveals.count).toBe(6)
  })

  it('marks sticky + parallax scroll-driven and carries the score through', () => {
    const dna = foldScrollMotion(rawStickyParallax)
    expect(dna.scrollDriven).toBe(true)
    expect(dna.stickyCount).toBe(2)
    expect(dna.parallax).toBe(0.6)
  })

  it('copies kinds (no shared reference back to the raw capture)', () => {
    const dna = foldScrollMotion(rawReveals)
    expect(dna.reveals.kinds).not.toBe(rawReveals.reveals.kinds)
    expect(dna.reveals.kinds).toEqual(rawReveals.reveals.kinds)
  })
})

// ── createScrollCapturer (faked page) ─────────────────────────────────────────

function fakePage(result: ScrollStepSample[] | Error): ScrollCapturePage {
  return {
    async evaluate<R>(): Promise<R> {
      if (result instanceof Error) throw result
      return result as unknown as R
    },
  }
}

describe('createScrollCapturer', () => {
  it('folds the page-returned samples into a RawScrollCapture', async () => {
    const raw = await createScrollCapturer().capture(fakePage(stickyParallax))
    expect(raw).toBeDefined()
    expect(raw!.stickyCount).toBe(1)
    expect(raw!.parallax).toBe(0.5)
  })

  it('returns undefined when the page yields no samples', async () => {
    expect(await createScrollCapturer().capture(fakePage([]))).toBeUndefined()
  })

  it('returns undefined (never throws) when page evaluation fails', async () => {
    expect(await createScrollCapturer().capture(fakePage(new Error('CSP blocked eval')))).toBeUndefined()
  })
})
