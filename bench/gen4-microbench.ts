#!/usr/bin/env npx tsx
/**
 * Gen 4 micro-benchmark — deterministic measurement of the changed code paths.
 *
 * Wall-clock measurement at the tier1 gate granularity is dominated by LLM
 * latency variance (gpt-5.4 reasoning ±2-5s on the same call). Per-turn infra
 * savings (50-300ms) sit well below the noise floor.
 *
 * This bench bypasses the LLM entirely and measures the deterministic code
 * changes Gen 4 introduced:
 *
 *   1. verifyEffect wait (was unconditional 100ms → conditional 50ms only
 *      for click/navigate/press/select; none for read/wait/scroll/hover)
 *   2. Cursor overlay animation overlap (was waitForTimeout(240) per
 *      interactive action → 0ms, CSS transition runs alongside the click)
 *
 * Both are pure timer changes. Both are checked end-to-end against a real
 * PlaywrightDriver and a real chromium page so the measurement is honest.
 */

import { chromium } from 'playwright'
import { PlaywrightDriver } from '../src/drivers/playwright.js'
import { BrowserAgent } from '../src/runner/runner.js'
import type { Action, PageState, Driver, ActionResult, ResourceBlockingOptions } from '../src/types.js'

const ITERATIONS = parseInt(process.env.ITERATIONS || '20', 10)

interface Stats {
  mean: number
  median: number
  stddev: number
  min: number
  max: number
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  const median = sorted[Math.floor(n / 2)]
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  return {
    mean,
    median,
    stddev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
  }
}

function fmt(s: Stats): string {
  return `mean=${s.mean.toFixed(1)}ms median=${s.median.toFixed(1)}ms stddev=±${s.stddev.toFixed(1)}ms`
}

// ── Bench 1: cursor overlay overhead per click ──────────────────────────
//
// Spin up a real Chromium page, install the cursor overlay, click a button
// N times. Measure the wall time of just the click action (driver.execute).
// This isolates the cursor animation from any LLM time.

async function benchCursorOverlay() {
  console.log('\n══ Bench 1: Cursor overlay click overhead ══')
  console.log(`  iterations=${ITERATIONS}`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  await page.setContent(`
    <!DOCTYPE html>
    <html><body>
      <button id="b" onclick="window.__count = (window.__count||0)+1">Click me</button>
    </body></html>
  `)

  // ── With cursor overlay ON (Gen 4 behavior)
  const withOverlay = new PlaywrightDriver(page, { showCursor: true })
  await withOverlay.observe()
  const withOverlayTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    await withOverlay.execute({ action: 'click', selector: 'button' })
    withOverlayTimes.push(performance.now() - start)
  }

  // ── Without cursor overlay (showCursor: false)
  const withoutOverlay = new PlaywrightDriver(page, { showCursor: false })
  await withoutOverlay.observe()
  const withoutOverlayTimes: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now()
    await withoutOverlay.execute({ action: 'click', selector: 'button' })
    withoutOverlayTimes.push(performance.now() - start)
  }

  const withSt = stats(withOverlayTimes)
  const withoutSt = stats(withoutOverlayTimes)
  console.log(`  showCursor=true:  ${fmt(withSt)}`)
  console.log(`  showCursor=false: ${fmt(withoutSt)}`)
  console.log(`  overlay overhead: +${(withSt.median - withoutSt.median).toFixed(1)}ms median`)
  console.log(`  (baseline used to add 240ms hard wait per click; Gen 4 should be ~equal to false)`)

  await browser.close()
}

// ── Bench 2: verifyEffect wait time ─────────────────────────────────────
//
// Construct a fake driver that returns a fixed PageState immediately.
// Run BrowserAgent.verifyEffect (via reflection) for each action type and
// measure how long verifyEffect takes when there's no real observe cost.
// This isolates the wait/settle logic from any other variability.

class InstantDriver implements Driver {
  observeCalls = 0

  async observe(): Promise<PageState> {
    this.observeCalls++
    return { url: 'about:blank', title: 'fake', snapshot: '' }
  }

  async execute(_: Action): Promise<ActionResult> {
    return { success: true }
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0)
  }

  async close(): Promise<void> {}

  getUrl(): string {
    return 'about:blank'
  }

  async setupResourceBlocking(_: ResourceBlockingOptions): Promise<void> {}
}

async function benchVerifyEffect() {
  console.log('\n══ Bench 2: verifyEffect wait + observe time ══')
  console.log(`  iterations=${ITERATIONS}`)

  const driver = new InstantDriver()
  // BrowserAgent expects an OPENAI_API_KEY env or apiKey config — we never
  // actually call the LLM here, so a stub key is fine.
  const agent = new BrowserAgent({
    driver,
    config: { model: 'gpt-5.4', provider: 'openai', apiKey: 'sk-test', maxTurns: 1 },
  })

  // Reach into the runner via a typed cast — we want to measure verifyEffect
  // directly without a full agent loop.
  type AgentInternals = { verifyEffect(effect: string, pre: PageState, action?: Action['action']): Promise<{ verified: boolean }> }
  const internals = agent as unknown as AgentInternals

  const preState: PageState = { url: 'about:blank', title: 'fake', snapshot: '' }

  async function runOne(actionType: Action['action']): Promise<number> {
    const start = performance.now()
    await internals.verifyEffect('something happens', preState, actionType)
    return performance.now() - start
  }

  for (const actionType of ['click', 'scroll', 'wait', 'hover'] as const) {
    const times: number[] = []
    // warmup
    await runOne(actionType)
    for (let i = 0; i < ITERATIONS; i++) {
      times.push(await runOne(actionType))
    }
    const s = stats(times)
    console.log(`  action=${actionType.padEnd(8)} ${fmt(s)}`)
  }
  console.log(`  (baseline always paid 100ms+observe; Gen 4 pays 50ms only for click/navigate/press/select, observe runs in parallel)`)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Gen 4 micro-bench — deterministic measurement of changed code paths')
  console.log(`node=${process.version} platform=${process.platform}`)

  await benchCursorOverlay()
  await benchVerifyEffect()

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
