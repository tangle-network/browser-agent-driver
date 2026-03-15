/**
 * CAPTCHA solving using LLM vision.
 *
 * Strategy-based: detection classifies the CAPTCHA type, a solvability map
 * routes to the right solver (or rejects unsolvable types immediately).
 *
 * Supports reCAPTCHA v2 image grids (3x3 and 4x4, including dynamic tile
 * replacement). Cloudflare Turnstile and reCAPTCHA v3 are classified as
 * unsolvable (behavioral, no visual challenge).
 */

import type { Page, Frame } from 'playwright'
import type { LanguageModel } from 'ai'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaptchaConfig {
  enabled?: boolean
  /** Max solve attempts per encounter (default: 5) */
  maxAttempts?: number
}

export type CaptchaType = 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha' | 'turnstile' | 'image-challenge'

export interface CaptchaDetection {
  type: CaptchaType
  siteKey?: string
  pageUrl: string
}

export interface AttemptRecord {
  tilesClicked: number[]
  instruction: string
  modelRefused: boolean
  durationMs: number
}

export interface CaptchaSolveResult {
  success: boolean
  attempts: number
  type: CaptchaType | null
  instruction?: string
  attemptLog: AttemptRecord[]
  durationMs: number
  error?: string
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectCaptcha(page: Page): Promise<CaptchaDetection | null> {
  const pageUrl = page.url()
  const result = await page.evaluate(() => {
    const recaptcha = document.querySelector<HTMLElement>('.g-recaptcha[data-sitekey]')
    if (recaptcha) {
      const siteKey = recaptcha.getAttribute('data-sitekey') || ''
      const version = recaptcha.getAttribute('data-size') === 'invisible' ? 'recaptcha-v3' : 'recaptcha-v2'
      return { type: version, siteKey }
    }
    const recaptchaScript = document.querySelector<HTMLScriptElement>('script[src*="recaptcha"]')
    if (recaptchaScript) {
      const m = recaptchaScript.src.match(/[?&]render=([^&]+)/)
      if (m && m[1] !== 'explicit') return { type: 'recaptcha-v3', siteKey: m[1] }
    }
    const recaptchaIframe = document.querySelector<HTMLIFrameElement>('iframe[src*="recaptcha"]')
    if (recaptchaIframe) {
      const m = recaptchaIframe.src.match(/[?&]k=([^&]+)/)
      if (m) return { type: 'recaptcha-v2', siteKey: m[1] }
    }
    const hcaptcha = document.querySelector<HTMLElement>('.h-captcha[data-sitekey]')
    if (hcaptcha) return { type: 'hcaptcha', siteKey: hcaptcha.getAttribute('data-sitekey') || '' }
    const hcaptchaIframe = document.querySelector<HTMLIFrameElement>('iframe[src*="hcaptcha"]')
    if (hcaptchaIframe) {
      const m = hcaptchaIframe.src.match(/sitekey=([^&]+)/)
      if (m) return { type: 'hcaptcha', siteKey: m[1] }
    }
    const turnstile = document.querySelector<HTMLElement>('.cf-turnstile[data-sitekey]')
    if (turnstile) return { type: 'turnstile', siteKey: turnstile.getAttribute('data-sitekey') || '' }
    const turnstileIframe = document.querySelector<HTMLIFrameElement>('iframe[src*="challenges.cloudflare.com"]')
    if (turnstileIframe) {
      const m = turnstileIframe.src.match(/[?&]k=([^&]+)/)
      if (m) return { type: 'turnstile', siteKey: m[1] }
    }
    const challengeIframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="captcha"], iframe[src*="challenge"], iframe[src*="arkoselabs"]'
    )
    if (challengeIframe) return { type: 'image-challenge', siteKey: undefined }
    return null
  }) as { type: string; siteKey?: string } | null

  if (!result) return null
  return { type: result.type as CaptchaType, siteKey: result.siteKey, pageUrl }
}

// ---------------------------------------------------------------------------
// Solvability
// ---------------------------------------------------------------------------

const SOLVABLE_TYPES = new Set<CaptchaType>(['recaptcha-v2'])

/** Whether we have a solver implementation for this CAPTCHA type */
export function isSolvable(type: CaptchaType): boolean {
  return SOLVABLE_TYPES.has(type)
}

/** Pre-filter: should we even try CAPTCHA solving given the terminal blocker evidence? */
export function canAttemptSolve(evidence: string[]): boolean {
  if (evidence.length === 0) return false
  // If evidence contains captcha/verify-human signals, there's a solvable challenge
  const solvableSignals = ['captcha', 'verify-human']
  return evidence.some(e => solvableSignals.some(s => e.includes(s)))
}

// ---------------------------------------------------------------------------
// Human-like interaction
// ---------------------------------------------------------------------------

function randomDelay(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min))
}

function jitteredPoint(box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const jitterX = (Math.random() - 0.5) * box.width * 0.4
  const jitterY = (Math.random() - 0.5) * box.height * 0.4
  return {
    x: box.x + box.width / 2 + jitterX,
    y: box.y + box.height / 2 + jitterY,
  }
}

// ---------------------------------------------------------------------------
// Model refusal detection
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS = [
  /I can'?t assist/i,
  /I'?m unable to/i,
  /cannot help with/i,
  /I'?m not able to/i,
  /against my guidelines/i,
  /can'?t (?:solve|complete|assist with) (?:this|the|captcha)/i,
  /not available to view/i,
  /I'?m sorry/i,
]

function isModelRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some(p => p.test(text))
}

// ---------------------------------------------------------------------------
// Frame + DOM helpers
// ---------------------------------------------------------------------------

function findChallengeFrame(page: Page): Frame | null {
  return page.frames().find(f => f.url().includes('recaptcha/api2/bframe'))
    || page.frames().find(f => f.url().includes('hcaptcha.com/captcha'))
    || null
}

async function annotateTiles(frame: Frame): Promise<number> {
  return frame.evaluate(() => {
    const tds = document.querySelectorAll('td')
    tds.forEach((td, i) => {
      td.querySelectorAll('.tile-label').forEach(el => el.remove())
      const label = document.createElement('div')
      label.className = 'tile-label'
      label.textContent = String(i + 1)
      label.style.cssText = `
        position: absolute; top: 4px; left: 4px; z-index: 9999;
        background: rgba(255,0,0,0.85); color: white; font-weight: bold;
        font-size: 18px; padding: 2px 6px; border-radius: 4px;
        pointer-events: none; font-family: Arial, sans-serif;
      `
      td.style.position = 'relative'
      td.appendChild(label)
    })
    return tds.length
  })
}

async function isRecaptchaSolved(page: Page): Promise<boolean> {
  const anchorFrame = page.frames().find(f => f.url().includes('recaptcha/api2/anchor'))
  if (anchorFrame) {
    const checked = await anchorFrame.evaluate(() =>
      document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked') === 'true'
    ).catch(() => false)
    if (checked) return true
  }
  return page.evaluate(() => {
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null
    return !!ta?.value
  }).catch(() => false)
}

async function screenshotChallenge(page: Page): Promise<string | null> {
  // Prefer iframe screenshot (tighter crop = better LLM accuracy)
  for (const sel of ['iframe[src*="recaptcha/api2/bframe"]', 'iframe[src*="hcaptcha.com/captcha"]']) {
    try {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 2000 })) {
        return (await el.screenshot({ type: 'png' })).toString('base64')
      }
    } catch { /* try next */ }
  }
  // Fallback: full page
  try { return (await page.screenshot({ type: 'png' })).toString('base64') } catch { return null }
}

async function getInstruction(frame: Frame): Promise<{ tdCount: number; instruction: string } | null> {
  return frame.evaluate(() => {
    const desc = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical')
    return { tdCount: document.querySelectorAll('td').length, instruction: desc?.textContent || '' }
  }).catch(() => null)
}

/** Check if tiles are still loading/fading after a click (dynamic replacement) */
async function hasPendingTiles(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => {
    // reCAPTCHA adds transition classes during tile replacement
    const pending = document.querySelectorAll('.rc-image-tile-pending, .rc-imageselect-dynamic-selected')
    if (pending.length > 0) return true
    // Also check for images still loading
    const images = document.querySelectorAll<HTMLImageElement>('td img')
    for (const img of images) {
      if (!img.complete || img.naturalWidth === 0) return true
    }
    return false
  }).catch(() => false)
}

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

const CAPTCHA_PROMPT = `You are solving an image grid CAPTCHA.

The screenshot shows a grid of image tiles. Each tile has a RED NUMBER LABEL in the top-left corner.
The instruction at the top says what to select (e.g. "Select all images with bridges").

Return the numbers of ALL tiles containing the target object.

RULES:
- Read the red number on each tile to identify it
- Include tiles where the target is visible, even partially
- Be thorough — include borderline matches
- For "bridges": include overpasses, footbridges, highway bridges
- For "vehicles": include partially visible ones

Respond with ONLY a JSON array of tile numbers:
[3, 6, 7, 8]`

interface AskResult {
  tiles: number[]
  refused: boolean
  raw: string
}

async function askModel(
  model: LanguageModel,
  screenshot: string,
  instruction: string,
  fallbackModel?: LanguageModel,
): Promise<AskResult> {
  const { generateText } = await import('ai')

  const messages = [{
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: `Instruction: "${instruction}". Which numbered tiles match? JSON array only.` },
      { type: 'image' as const, image: screenshot, mediaType: 'image/png' as const },
    ],
  }]

  const tryModel = async (m: LanguageModel): Promise<AskResult> => {
    const result = await generateText({
      model: m,
      system: CAPTCHA_PROMPT,
      messages,
      maxOutputTokens: 100,
    })
    const text = result.text.trim()
    if (isModelRefusal(text)) return { tiles: [], refused: true, raw: text }
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const tiles = Array.isArray(parsed) ? parsed : parsed.tiles || []
    return { tiles: tiles.filter((t: unknown) => typeof t === 'number'), refused: false, raw: text }
  }

  // Try primary model
  try {
    const result = await tryModel(model)
    if (!result.refused || !fallbackModel) return result
  } catch {
    if (!fallbackModel) return { tiles: [], refused: false, raw: '' }
  }

  // Fallback model on refusal or error
  try {
    return await tryModel(fallbackModel)
  } catch {
    return { tiles: [], refused: true, raw: '' }
  }
}

// ---------------------------------------------------------------------------
// reCAPTCHA v2 solver
// ---------------------------------------------------------------------------

async function solveRecaptchaV2(
  page: Page,
  model: LanguageModel,
  maxAttempts: number,
  fallbackModel?: LanguageModel,
): Promise<CaptchaSolveResult> {
  const start = Date.now()
  const attemptLog: AttemptRecord[] = []

  // Click checkbox to trigger image challenge
  try {
    const anchor = page.frameLocator('iframe[src*="recaptcha/api2/anchor"]')
    await anchor.locator('#recaptcha-anchor').click({ timeout: 5000 })
    await page.waitForTimeout(randomDelay(2500, 3500))
  } catch {
    return { success: false, attempts: 0, type: 'recaptcha-v2', attemptLog, durationMs: Date.now() - start, error: 'checkbox click failed' }
  }

  // Might auto-pass without challenge
  if (await isRecaptchaSolved(page)) {
    return { success: true, attempts: 0, type: 'recaptcha-v2', attemptLog, durationMs: Date.now() - start }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now()
    if (attempt > 1) await page.waitForTimeout(randomDelay(1500, 2500))

    const frame = findChallengeFrame(page)
    if (!frame) {
      if (await isRecaptchaSolved(page)) {
        return { success: true, attempts: attempt, type: 'recaptcha-v2', attemptLog, durationMs: Date.now() - start }
      }
      continue
    }

    // Wait for tiles
    await frame.waitForSelector('td', { timeout: 5000 }).catch(() => {})
    const info = await getInstruction(frame)
    if (!info?.tdCount) {
      if (await isRecaptchaSolved(page)) {
        return { success: true, attempts: attempt, type: 'recaptcha-v2', attemptLog, durationMs: Date.now() - start }
      }
      continue
    }

    const isDynamic = info.instruction.toLowerCase().includes('none left')

    // Annotate, screenshot, ask LLM
    await annotateTiles(frame).catch(() => {})
    await page.waitForTimeout(randomDelay(300, 600))
    const screenshot = await screenshotChallenge(page)
    if (!screenshot) continue

    const ask = await askModel(model, screenshot, info.instruction, fallbackModel)
    attemptLog.push({
      tilesClicked: ask.tiles,
      instruction: info.instruction,
      modelRefused: ask.refused,
      durationMs: Date.now() - attemptStart,
    })

    if (ask.refused || ask.tiles.length === 0) continue

    // Click tiles with human-like timing
    const tds = frame.locator('td')
    for (const t of ask.tiles) {
      const idx = t - 1
      if (idx < 0 || idx >= info.tdCount) continue
      const box = await tds.nth(idx).boundingBox().catch(() => null)
      if (box) {
        const pt = jitteredPoint(box)
        await page.mouse.click(pt.x, pt.y)
      } else {
        await tds.nth(idx).click({ timeout: 2000 }).catch(() => {})
      }
      await page.waitForTimeout(randomDelay(200, 700))
    }

    // Dynamic tile replacement loop — re-analyze after tiles fade in
    if (isDynamic) {
      for (let sub = 0; sub < 3; sub++) {
        await page.waitForTimeout(1500)
        if (!await hasPendingTiles(frame)) {
          // Re-screenshot and check for new matching tiles
          await annotateTiles(frame).catch(() => {})
          await page.waitForTimeout(300)
          const subShot = await screenshotChallenge(page)
          if (!subShot) break
          const subAsk = await askModel(model, subShot, info.instruction, fallbackModel)
          if (subAsk.tiles.length === 0 || subAsk.refused) break
          // Click new matches
          for (const t of subAsk.tiles) {
            const idx = t - 1
            if (idx < 0 || idx >= info.tdCount) continue
            const box = await tds.nth(idx).boundingBox().catch(() => null)
            if (box) {
              const pt = jitteredPoint(box)
              await page.mouse.click(pt.x, pt.y)
            }
            await page.waitForTimeout(randomDelay(200, 700))
          }
        }
      }
    }

    // Click verify
    await page.waitForTimeout(randomDelay(400, 800))
    await frame.locator('#recaptcha-verify-button').click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(randomDelay(2000, 3000))

    if (await isRecaptchaSolved(page)) {
      return {
        success: true,
        attempts: attempt,
        type: 'recaptcha-v2',
        instruction: info.instruction,
        attemptLog,
        durationMs: Date.now() - start,
      }
    }
  }

  return {
    success: false,
    attempts: maxAttempts,
    type: 'recaptcha-v2',
    attemptLog,
    durationMs: Date.now() - start,
    error: 'max attempts reached',
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect and solve a CAPTCHA on the current page using LLM vision.
 *
 * Returns immediately for unsolvable types (Turnstile, reCAPTCHA v3).
 * For solvable types, annotates tiles, screenshots, asks the LLM, clicks
 * with human-like timing, and handles dynamic tile replacement.
 */
export async function solveCaptcha(
  page: Page,
  model: LanguageModel,
  opts?: {
    maxAttempts?: number
    fallbackModel?: LanguageModel
  },
): Promise<CaptchaSolveResult> {
  const start = Date.now()
  const maxAttempts = opts?.maxAttempts ?? 5
  const emptyResult = (error: string, type: CaptchaType | null = null): CaptchaSolveResult => ({
    success: false, attempts: 0, type, attemptLog: [], durationMs: Date.now() - start, error,
  })

  const detection = await detectCaptcha(page)
  if (!detection) return emptyResult('no captcha detected')
  if (!isSolvable(detection.type)) return emptyResult(`unsolvable type: ${detection.type}`, detection.type)

  // Dispatch to type-specific solver
  switch (detection.type) {
    case 'recaptcha-v2':
      return solveRecaptchaV2(page, model, maxAttempts, opts?.fallbackModel)
    default:
      return emptyResult(`no solver for: ${detection.type}`, detection.type)
  }
}
