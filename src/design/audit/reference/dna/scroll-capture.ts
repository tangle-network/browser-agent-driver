/**
 * Scroll-driven motion capture — the opt-in `captureScrollMotion` pass.
 *
 * Three concerns, deliberately split so the JUDGEMENT is pure and unit-testable
 * while only the raw DOM read touches a browser:
 *
 *  1. `scrollSampleCollector` — the HERMETIC in-page function. It scrolls the
 *     live page top→bottom in N stops and, at each stop, reads a bounded set of
 *     elements' `getBoundingClientRect` + `getComputedStyle(opacity/transform/
 *     position)`. It emits raw `ScrollStepSample[]` and makes NO judgement. It
 *     references only browser globals + its own args (no module scope) so
 *     Playwright can serialise it into the page.
 *  2. `detectRawScrollCapture` — the PURE detector. It folds the sampled steps
 *     into a `RawScrollCapture` (reveal count/kinds, sticky count, parallax
 *     score, heights) with NO browser, NO IO, deterministic — so it unit-tests
 *     on `ScrollStepSample` fixtures alone.
 *  3. `foldScrollMotion` — the PURE rollup. It normalises a `RawScrollCapture`
 *     into the DNA-altitude `ScrollMotionDNA`, computing the derived
 *     `pageHeightRatio` and the `scrollDriven` verdict (the two fields the raw
 *     capture deliberately leaves to the fold). Unit-tests on `RawScrollCapture`
 *     fixtures.
 *
 * `createScrollCapturer` wires (1)+(2) behind the narrow `ScrollCapturePage`
 * seam — it depends only on `evaluate`, never on Playwright, so it is browser-
 * free and fakeable. The live token extractor (`design/audit/tokens/extract.ts`)
 * hands it a real `Page`; tests hand it a fake whose `evaluate` returns canned
 * samples.
 *
 * Honest signals: every quantity is measured. The capturer returns `undefined`
 * for a page that cannot scroll (nothing to observe); a page that scrolls but
 * shows little motion returns a real record that the fold marks
 * `scrollDriven: false` — distinct from absence.
 */

import type {
  RawScrollCapture,
  ScrollMotionDNA,
  ScrollRevealSummary,
  ScrollCapturer,
  ScrollCapturePage,
  ScrollCaptureOptions,
} from '../contracts.js'

// ── tuning (pure, documented) ────────────────────────────────────────────────

// A page whose scrollable range is below this (CSS px) is treated as
// non-scrolling: there is nothing to observe, so the capturer returns undefined.
const MIN_SCROLL_RANGE_PX = 48
// Opacity at/below this reads as "hidden" (reveal start); at/above HI reads as
// "shown" (reveal end).
const OPACITY_HIDDEN = 0.1
const OPACITY_SHOWN = 0.9
// A transform translateY of at least this (px) before settling to ~0 reads as a
// slide reveal; SETTLED is the post-settle tolerance.
const SLIDE_START_PX = 12
const SLIDE_SETTLED_PX = 4
// A scale this far from 1 before settling to ~1 reads as a scale-in reveal.
const SCALE_START = 0.08
const SCALE_SETTLED = 0.03
// An element is "below / entering" (reveal candidate start) when its viewport
// top sits at/under this fraction of the viewport, and "in view" (reveal end)
// when its top sits at/above the IN fraction.
const ENTER_FRACTION = 0.75
const INVIEW_FRACTION = 0.85
// A pinned element's viewport top must vary less than this (px) across the stops
// where it is pinned, while scroll advances at least PIN_MIN_SCROLL_PX.
const STICKY_TOP_VARIANCE_PX = 8
const PIN_MIN_SCROLL_PX = 100
// Parallax: a layer's translate rate (viewport movement ÷ scroll movement).
// 1 = rigid with content, 0 = fixed/pinned. A genuine parallax layer sits in
// the slow band (LO,HI) or moves faster than content (>FAST). The score is the
// clamped distance of that rate from rigid (1).
const PARALLAX_SLOW_LO = 0.15
const PARALLAX_SLOW_HI = 0.85
const PARALLAX_FAST = 1.15
// A transform reveal (slide / scale) only counts for a layer that, once shown,
// moves RIGIDLY with the content (translate rate within ±this of 1). This is the
// exact complement of the parallax bands above, so a parallax layer can never be
// double-read as a slide. Disjoint by construction: rigid = [0.85, 1.15].
const RIGID_RATE_TOLERANCE = 0.15
// scrollDriven rollup thresholds.
const SCROLL_DRIVEN_MIN_REVEALS = 2
const SCROLL_DRIVEN_MIN_PARALLAX = 0.25

const round2 = (n: number): number => Math.round(n * 100) / 100
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)
const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(n)))

// ── raw sample wire format (collector → detector) ────────────────────────────

/**
 * One element's measurement at a single scroll stop. `i` is the element's
 * stable index in the captured element list, identical across every stop, so the
 * detector can reconstruct each element's series.
 */
export interface ElementSample {
  /** Stable element index across all stops. */
  i: number
  /** `getBoundingClientRect().top` in viewport CSS px. */
  top: number
  /** `getBoundingClientRect().bottom` in viewport CSS px. */
  bottom: number
  /** Computed `opacity`, 0–1. */
  opacity: number
  /** Parsed `translateY` from the computed transform, CSS px. */
  ty: number
  /** Parsed vertical scale from the computed transform (1 = none). */
  scale: number
  /** Computed `position` (`static` / `sticky` / `fixed` / …). */
  position: string
}

/** One top→bottom scroll stop: the scroll geometry plus every tracked element. */
export interface ScrollStepSample {
  /** `window.scrollY` at this stop. */
  scrollY: number
  /** `window.innerHeight` at capture time. */
  viewportHeight: number
  /** `document.scrollingElement.scrollHeight` at capture time. */
  scrollHeight: number
  /** Per-element measurements at this stop. */
  elements: ElementSample[]
}

// ── (1) in-page collector — HERMETIC, runs in the browser ────────────────────

/**
 * Scroll the live page top→bottom in `steps` stops, sampling up to
 * `maxElements` elements at each. Pure DOM read — emits raw samples, makes NO
 * judgement. HERMETIC: references only its args + browser globals (no module
 * scope) so it survives `Function.prototype.toString` serialisation into the
 * page. Restores the original scroll position before returning.
 */
export async function scrollSampleCollector(
  steps: number,
  settleMs: number,
  maxElements: number,
): Promise<ScrollStepSample[]> {
  const doc = document.scrollingElement || document.documentElement
  const viewportHeight = window.innerHeight
  const scrollHeight = doc ? doc.scrollHeight : document.body.scrollHeight
  const originalY = window.scrollY

  // Parse translateY + vertical scale out of a computed transform matrix.
  const parseTransform = (t: string): { ty: number; scale: number } => {
    if (!t || t === 'none') return { ty: 0, scale: 1 }
    const open = t.indexOf('(')
    const close = t.lastIndexOf(')')
    if (open < 0 || close <= open) return { ty: 0, scale: 1 }
    const nums = t
      .slice(open + 1, close)
      .split(',')
      .map((s) => parseFloat(s.trim()))
    if (nums.length === 6) return { ty: nums[5] || 0, scale: nums[3] || 1 }
    if (nums.length === 16) return { ty: nums[13] || 0, scale: nums[5] || 1 }
    return { ty: 0, scale: 1 }
  }

  // Capture the tracked element list ONCE so identity (index) is stable across
  // stops. Track a set SPREAD across the full document height — not the first N
  // nodes in DOM order, which cluster in the header/hero and miss everything that
  // reveals lower down the page (the original bug: reveal-heavy pages scored 0).
  // Skip tiny nodes, then evenly subsample by document position up to maxElements.
  const all = Array.from(document.body ? document.body.querySelectorAll('*') : [])
  const candidates: Array<{ el: Element; docTop: number }> = []
  for (const el of all) {
    const r = el.getBoundingClientRect()
    if (r.width < 24 || r.height < 12) continue
    candidates.push({ el, docTop: r.top + window.scrollY })
  }
  candidates.sort((a, b) => a.docTop - b.docTop)
  let tracked: Element[]
  if (candidates.length > maxElements) {
    const stride = candidates.length / maxElements
    tracked = []
    for (let k = 0; k < maxElements; k++) tracked.push(candidates[Math.floor(k * stride)].el)
  } else {
    tracked = candidates.map((c) => c.el)
  }

  const range = Math.max(0, scrollHeight - viewportHeight)
  const stops = Math.max(2, steps)
  const samples: ScrollStepSample[] = []

  for (let s = 0; s < stops; s++) {
    const targetY = range * (s / (stops - 1))
    window.scrollTo(0, targetY)
    // Let rAF + CSS transitions / scroll handlers settle before reading.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, settleMs)),
    )
    const elements: ElementSample[] = []
    for (let i = 0; i < tracked.length; i++) {
      const el = tracked[i]
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const { ty, scale } = parseTransform(cs.transform)
      const opacity = parseFloat(cs.opacity)
      elements.push({
        i,
        top: r.top,
        bottom: r.bottom,
        opacity: Number.isFinite(opacity) ? opacity : 1,
        ty,
        scale,
        position: cs.position,
      })
    }
    samples.push({ scrollY: window.scrollY, viewportHeight, scrollHeight, elements })
  }

  window.scrollTo(0, originalY)
  return samples
}

// ── (2) pure detector — samples → RawScrollCapture ───────────────────────────

interface Obs {
  scrollY: number
  viewportHeight: number
  top: number
  bottom: number
  opacity: number
  ty: number
  scale: number
  position: string
}

function seriesByElement(samples: ScrollStepSample[]): Map<number, Obs[]> {
  const byEl = new Map<number, Obs[]>()
  for (const step of samples) {
    for (const e of step.elements) {
      const obs: Obs = {
        scrollY: step.scrollY,
        viewportHeight: step.viewportHeight,
        top: e.top,
        bottom: e.bottom,
        opacity: e.opacity,
        ty: e.ty,
        scale: e.scale,
        position: e.position,
      }
      const arr = byEl.get(e.i)
      if (arr) arr.push(obs)
      else byEl.set(e.i, [obs])
    }
  }
  for (const arr of byEl.values()) arr.sort((a, b) => a.scrollY - b.scrollY)
  return byEl
}

/**
 * Classify one element's series as a reveal, returning its kind or null.
 *
 * Compares the element's HIDDEN state (strongest hidden reading while it sits
 * below / entering the viewport) against its SHOWN state (most-settled reading
 * once it has scrolled into view), aggregating EXTREMES across every sampled stop
 * rather than trusting a single frame. A stop can easily land mid-transition (the
 * per-stop settle window is shorter than a typical 300–600ms reveal), so a
 * first-match "after" frame routinely catches an in-flight opacity/transform and
 * misses a real reveal; the extreme over all shown frames does not.
 */
function classifyReveal(series: Obs[]): string | null {
  if (series.length < 2) return null
  const vh = series[0].viewportHeight
  // "entering": frames where the element sits below / at the bottom edge of the
  // viewport — its hidden start zone. "later": frames at a DEEPER scroll where it
  // has risen above the in-view line. A reveal completes and then STAYS settled
  // (the element does not re-hide as it scrolls off the top), so the shown
  // reading is NOT gated on the element still being on-screen — gating it on
  // `bottom >= 0` would miss reveals whose final settled frame is the one where
  // the element has just scrolled past the viewport top.
  const entering = series.filter((o) => o.top >= vh * ENTER_FRACTION)
  if (entering.length === 0) return null
  const firstEnterY = Math.min(...entering.map((o) => o.scrollY))
  const later = series.filter((o) => o.scrollY > firstEnterY && o.top < vh * INVIEW_FRACTION)
  if (later.length === 0) return null

  const hiddenOpacity = Math.min(...entering.map((o) => o.opacity))
  const shownOpacity = Math.max(...later.map((o) => o.opacity))
  if (hiddenOpacity <= OPACITY_HIDDEN && shownOpacity >= OPACITY_SHOWN) return 'fade'

  // Slide / scale only count for a layer that, once shown, moves rigidly with the
  // content; a parallax layer keeps translating at a non-rigid rate and must not
  // be mis-read as a slide.
  const laterRate = translateRate(later)
  const rigidWhenShown = laterRate !== null && Math.abs(laterRate - 1) <= RIGID_RATE_TOLERANCE
  if (rigidWhenShown) {
    const enterTy = entering.reduce((m, o) => (Math.abs(o.ty) > Math.abs(m) ? o.ty : m), 0)
    const shownTy = Math.min(...later.map((o) => Math.abs(o.ty)))
    if (Math.abs(enterTy) >= SLIDE_START_PX && shownTy <= SLIDE_SETTLED_PX) {
      return enterTy > 0 ? 'slide-up' : 'slide-down'
    }
    const enterScale = entering.reduce((m, o) => (Math.abs(o.scale - 1) > Math.abs(m - 1) ? o.scale : m), 1)
    const shownScale = Math.min(...later.map((o) => Math.abs(o.scale - 1)))
    if (Math.abs(enterScale - 1) >= SCALE_START && shownScale <= SCALE_SETTLED) return 'scale-in'
  }
  return null
}

/** True when an element stayed pinned (sticky/fixed, ~constant top) while scrolled. */
function isPinned(series: Obs[]): boolean {
  const pinned = series.filter((o) => o.position === 'sticky' || o.position === 'fixed')
  if (pinned.length < 2) return false
  const tops = pinned.map((o) => o.top)
  const topRange = Math.max(...tops) - Math.min(...tops)
  const scrollSpan = pinned[pinned.length - 1].scrollY - pinned[0].scrollY
  // Pinned only counts while the element is actually within the viewport band.
  const inView = pinned.some((o) => o.top >= -STICKY_TOP_VARIANCE_PX && o.top <= o.viewportHeight)
  return inView && topRange <= STICKY_TOP_VARIANCE_PX && scrollSpan >= PIN_MIN_SCROLL_PX
}

/** Median translate rate of an element vs scroll, or null when it never moved with scroll. */
function translateRate(series: Obs[]): number | null {
  const rates: number[] = []
  for (let k = 1; k < series.length; k++) {
    const prev = series[k - 1]
    const cur = series[k]
    const dScroll = cur.scrollY - prev.scrollY
    if (dScroll <= 0) continue
    // Rigid content moves up by dScroll in viewport coords (top decreases by dScroll).
    rates.push((prev.top - cur.top) / dScroll)
  }
  if (rates.length === 0) return null
  rates.sort((a, b) => a - b)
  const mid = Math.floor(rates.length / 2)
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2
}

/**
 * Fold sampled scroll steps into a `RawScrollCapture`, or `undefined` when the
 * page could not scroll (nothing to observe). Pure + deterministic.
 */
export function detectRawScrollCapture(samples: ScrollStepSample[]): RawScrollCapture | undefined {
  if (samples.length < 2) return undefined
  const viewportHeightPx = samples[0].viewportHeight
  const scrollHeightPx = Math.max(...samples.map((s) => s.scrollHeight))
  if (viewportHeightPx <= 0) return undefined
  if (scrollHeightPx - viewportHeightPx < MIN_SCROLL_RANGE_PX) return undefined

  const byEl = seriesByElement(samples)

  let revealCount = 0
  const kinds = new Set<string>()
  let stickyCount = 0
  let parallax = 0

  for (const series of byEl.values()) {
    const pinned = isPinned(series)
    if (pinned) stickyCount++

    const kind = classifyReveal(series)
    if (kind) {
      revealCount++
      kinds.add(kind)
    }

    if (!pinned) {
      const rate = translateRate(series)
      if (rate !== null) {
        const isSlow = rate > PARALLAX_SLOW_LO && rate < PARALLAX_SLOW_HI
        const isFast = rate > PARALLAX_FAST
        if (isSlow || isFast) parallax = Math.max(parallax, clamp01(Math.abs(rate - 1)))
      }
    }
  }

  const reveals: ScrollRevealSummary = { count: revealCount, kinds: [...kinds].sort() }
  return {
    scrollHeightPx,
    viewportHeightPx,
    steps: samples.length,
    reveals,
    stickyCount,
    parallax: round2(parallax),
  }
}

// ── (3) pure rollup — RawScrollCapture → ScrollMotionDNA ──────────────────────

/**
 * Normalise a raw scroll capture into the DNA-altitude `ScrollMotionDNA`,
 * computing the derived `pageHeightRatio` and the `scrollDriven` verdict the raw
 * capture leaves to the fold. Pure + deterministic.
 */
export function foldScrollMotion(raw: RawScrollCapture): ScrollMotionDNA {
  const pageHeightRatio = raw.viewportHeightPx > 0 ? round2(raw.scrollHeightPx / raw.viewportHeightPx) : 0
  const scrollDriven =
    raw.reveals.count >= SCROLL_DRIVEN_MIN_REVEALS ||
    raw.stickyCount >= 1 ||
    raw.parallax >= SCROLL_DRIVEN_MIN_PARALLAX
  return {
    pageHeightRatio,
    reveals: { count: raw.reveals.count, kinds: [...raw.reveals.kinds] },
    stickyCount: raw.stickyCount,
    parallax: raw.parallax,
    scrollDriven,
  }
}

// ── live harness behind the narrow seam ──────────────────────────────────────

const DEFAULT_STEPS = 12
const DEFAULT_SETTLE_MS = 160
const MAX_TRACKED_ELEMENTS = 900

/**
 * Build a no-arg page function that runs `scrollSampleCollector` with the
 * resolved tunables baked in as literals. The locked `ScrollCapturePage.evaluate`
 * seam is no-arg, and a serialised closure cannot carry config, so the values are
 * inlined into the function source. `Function` runs only in Node to mint the
 * wrapper; Playwright serialises and runs it in the page (CDP eval — not subject
 * to page CSP).
 */
function buildPageCollector(
  steps: number,
  settleMs: number,
  maxElements: number,
): () => Promise<ScrollStepSample[]> {
  const src = scrollSampleCollector.toString()
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`return (${src})(${steps}, ${settleMs}, ${maxElements})`) as () => Promise<ScrollStepSample[]>
}

/**
 * The shipped `ScrollCapturer`: drive a stepped top→bottom scroll on an already
 * open, settled page and fold it to a `RawScrollCapture`. Browser-free — depends
 * only on the `ScrollCapturePage.evaluate` seam — so a fake page drives it in
 * unit tests. Returns `undefined` when the page cannot scroll or evaluation fails.
 */
export function createScrollCapturer(): ScrollCapturer {
  return {
    async capture(page: ScrollCapturePage, opts: ScrollCaptureOptions = {}): Promise<RawScrollCapture | undefined> {
      const steps = clampInt(opts.steps ?? DEFAULT_STEPS, 3, 24)
      const settleMs = clampInt(opts.settleMs ?? DEFAULT_SETTLE_MS, 0, 1000)
      let samples: ScrollStepSample[]
      try {
        samples = await page.evaluate(buildPageCollector(steps, settleMs, MAX_TRACKED_ELEMENTS))
      } catch {
        return undefined
      }
      if (!Array.isArray(samples) || samples.length === 0) return undefined
      return detectRawScrollCapture(samples)
    },
  }
}
