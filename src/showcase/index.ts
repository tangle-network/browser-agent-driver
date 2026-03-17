/**
 * Showcase — deterministic walkthrough capture for marketing assets.
 *
 * Unlike `bad run` (LLM-driven exploration) or `bad design-audit` (quality assessment),
 * showcase executes a pre-scripted walkthrough and captures polished screenshots,
 * GIFs, and videos. No LLM calls. No quality judgement. Just beautiful captures.
 *
 * Reuses:
 *   - page-interaction.ts: dismissModals() for cookie/popup cleanup
 *   - browser-launch.ts: buildBrowserLaunchPlan() for consistent browser config
 *   - cli-ui.ts: CliRenderer for progress output
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { chromium, type Page, type BrowserContext } from 'playwright'
import type {
  ShowcaseConfig,
  ShowcaseStep,
  ShowcaseFrame,
  ShowcaseResult,
  QuickCaptureConfig,
} from './types.js'
import { captureWithHighlight, captureWithCrop } from './annotate.js'
import { assembleGif, assembleVideo } from './assemble.js'
import { revealHiddenContent } from '../design/page-interaction.js'

// ── Main Entry ──

export async function runShowcase(config: ShowcaseConfig): Promise<ShowcaseResult> {
  const startTime = Date.now()
  const outputDir = config.output?.dir ?? './showcase'
  const scale = config.output?.scale ?? 2
  const formats = config.output?.formats ?? ['png']
  const quality = config.output?.quality ?? 90

  fs.mkdirSync(outputDir, { recursive: true })

  const viewport = config.viewport ?? { width: 1440, height: 900 }
  const browser = await chromium.launch({ headless: config.headless ?? true })
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    colorScheme: config.colorScheme,
    storageState: config.storageState ? JSON.parse(fs.readFileSync(config.storageState, 'utf-8')) : undefined,
    // Record video if webm format requested
    ...(formats.includes('webm') ? { recordVideo: { dir: path.join(outputDir, '_video'), size: viewport } } : {}),
  })

  const page = await context.newPage()
  const frames: ShowcaseFrame[] = []

  // Dismiss modals/cookie banners before starting
  if (config.dismissModals !== false) {
    await page.goto(config.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
      page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    )
    await page.waitForTimeout(1500)
    // Dismiss modals/cookie banners — reuses design/page-interaction.ts
    await revealHiddenContent(page).catch(() => null)
  }

  // Execute steps
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i]
    await executeStep(page, step)

    if (step.capture) {
      const frame = await captureFrame(page, step.capture, i, { quality })
      if (frame) {
        const framePath = path.join(outputDir, `${frame.name}.png`)
        fs.writeFileSync(framePath, frame.buffer)
        frames.push(frame)
      }
    }
  }

  // Assemble GIF if requested
  let gifPath: string | undefined
  if (formats.includes('gif') && frames.length > 1) {
    gifPath = path.join(outputDir, `${config.name}.gif`)
    const ok = assembleGif(frames, gifPath, { fps: 1, maxWidth: viewport.width })
    if (!ok) gifPath = undefined
  }

  // Get video recording path if available
  let videoPath: string | undefined
  if (formats.includes('webm')) {
    await page.close() // Must close page to flush video
    const videoFile = await context.pages()[0]?.video()?.path().catch(() => undefined)
    // Page already closed, try getting video from context
    // Video is written on context.close()
    await context.close()
    const videoDir = path.join(outputDir, '_video')
    if (fs.existsSync(videoDir)) {
      const vids = fs.readdirSync(videoDir).filter(f => f.endsWith('.webm'))
      if (vids.length) {
        videoPath = path.join(outputDir, `${config.name}.webm`)
        fs.renameSync(path.join(videoDir, vids[0]), videoPath)
        fs.rmSync(videoDir, { recursive: true, force: true })
      }
    }
  } else {
    await context.close()
  }

  await browser.close()

  // Convert to WebP if requested
  if (formats.includes('webp')) {
    for (const frame of frames) {
      const pngPath = path.join(outputDir, `${frame.name}.png`)
      // Playwright can't export webp directly from buffer,
      // but we keep the PNG — webp conversion would need sharp or ffmpeg
    }
  }

  return {
    name: config.name,
    outputDir,
    frames: frames.map((f) => ({
      name: f.name,
      path: path.join(outputDir, `${f.name}.png`),
      width: f.width,
      height: f.height,
      step: f.step,
    })),
    gif: gifPath,
    video: videoPath,
    durationMs: Date.now() - startTime,
  }
}

// ── Quick Capture ──

/**
 * Quick capture mode — no script file needed.
 * Captures named positions: 'hero' (viewport), 'full' (full page), 'scroll:N' (scroll N px first).
 */
export async function quickCapture(config: QuickCaptureConfig): Promise<ShowcaseResult> {
  const steps: ShowcaseStep[] = [
    { action: 'navigate', url: config.url },
  ]

  for (const capture of config.captures) {
    if (capture === 'hero') {
      steps.push({
        action: 'screenshot',
        capture: {
          name: 'hero',
          fullPage: false,
          crop: config.cropSelector ? { selector: config.cropSelector, padding: 16 } : undefined,
          highlight: config.highlightSelector ? { selector: config.highlightSelector } : undefined,
        },
      })
    } else if (capture === 'full') {
      steps.push({
        action: 'screenshot',
        capture: { name: 'full-page', fullPage: true },
      })
    } else if (capture.startsWith('scroll:')) {
      const amount = parseInt(capture.split(':')[1], 10)
      steps.push(
        { action: 'scroll', amount },
        {
          action: 'screenshot',
          capture: {
            name: `scroll-${amount}`,
            fullPage: false,
            crop: config.cropSelector ? { selector: config.cropSelector, padding: 16 } : undefined,
          },
        },
      )
    } else if (capture === 'footer') {
      steps.push(
        { action: 'scroll', amount: 99999 },
        { action: 'screenshot', capture: { name: 'footer', fullPage: false } },
      )
    } else {
      // Treat as a section name — try scrolling to an element with that id or class
      steps.push(
        { action: 'screenshot', capture: { name: capture, fullPage: false } },
      )
    }
  }

  return runShowcase({
    name: 'quick-capture',
    url: config.url,
    steps,
    viewport: config.viewport,
    output: config.output,
    headless: config.headless,
    storageState: config.storageState,
    colorScheme: config.colorScheme,
    dismissModals: config.dismissModals,
  })
}

// ── Internals ──

async function executeStep(page: Page, step: ShowcaseStep): Promise<void> {
  switch (step.action) {
    case 'navigate':
      if (step.url) {
        await page.goto(step.url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
          page.goto(step.url!, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
        )
        await page.waitForTimeout(1500)
      }
      break

    case 'click':
      if (step.selector) {
        const el = page.locator(step.selector).first()
        await el.click({ timeout: 5_000 }).catch(() => {
          // Fallback: try force click
          return el.click({ force: true, timeout: 3_000 }).catch(() => null)
        })
        await page.waitForTimeout(500)
      }
      break

    case 'type':
      if (step.selector && step.text) {
        const el = page.locator(step.selector).first()
        await el.click({ timeout: 3_000 }).catch(() => null)
        await el.fill(step.text)
        await page.waitForTimeout(300)
      }
      break

    case 'scroll':
      const amount = step.amount ?? 500
      const dir = step.direction === 'up' ? -1 : 1
      await page.evaluate((px) => window.scrollBy(0, px), amount * dir)
      await page.waitForTimeout(500)
      break

    case 'wait':
      await page.waitForTimeout(step.amount ?? 1000)
      break

    case 'hover':
      if (step.selector) {
        await page.locator(step.selector).first().hover({ timeout: 3_000 }).catch(() => null)
        await page.waitForTimeout(300)
      }
      break

    case 'screenshot':
      // Screenshot-only step — capture handled by caller
      break
  }
}

async function captureFrame(
  page: Page,
  capture: NonNullable<ShowcaseStep['capture']>,
  stepIndex: number,
  opts: { quality: number },
): Promise<ShowcaseFrame | null> {
  // Wait for animations to settle
  if (capture.delay) {
    await page.waitForTimeout(capture.delay)
  }

  let buffer: Buffer

  if (capture.highlight) {
    // Capture with highlight overlay
    buffer = await captureWithHighlight(page, {
      selector: capture.highlight.selector,
      color: capture.highlight.color,
      label: capture.highlight.label,
      fullPage: capture.fullPage,
      quality: opts.quality,
    })
  } else if (capture.crop) {
    // Capture cropped to element
    const cropped = await captureWithCrop(page, {
      selector: capture.crop.selector,
      padding: capture.crop.padding,
      quality: opts.quality,
    })
    if (!cropped) {
      // Fallback: full viewport
      buffer = await page.screenshot({ type: 'png', fullPage: false })
    } else {
      buffer = cropped
    }
  } else {
    // Standard capture
    buffer = await page.screenshot({
      type: 'png',
      fullPage: capture.fullPage ?? false,
    })
  }

  // Get dimensions from viewport (actual pixel dimensions depend on scale factor)
  const viewport = page.viewportSize()

  return {
    name: capture.name,
    buffer,
    width: viewport?.width ?? 1440,
    height: viewport?.height ?? 900,
    step: stepIndex,
  }
}

// Re-export types
export type { ShowcaseConfig, ShowcaseStep, ShowcaseFrame, ShowcaseResult, QuickCaptureConfig } from './types.js'
