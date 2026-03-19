import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import chalk from 'chalk'

const DEFAULT_PATH = '.auth/storage-state.json'

function resolve(input?: string): string {
  return path.resolve(input || process.env.AI_TANGLE_STORAGE_STATE_PATH || DEFAULT_PATH)
}

function validate(filePath: string) {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Storage state file not found: ${resolved}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
  } catch {
    throw new Error(`Storage state is not valid JSON: ${resolved}`)
  }

  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj?.cookies) || !Array.isArray(obj?.origins)) {
    throw new Error(`Storage state must contain cookies[] and origins[]: ${resolved}`)
  }

  const cookies = obj.cookies as unknown[]
  const origins = obj.origins as Array<{ origin?: string }>

  return {
    path: resolved,
    parsed: obj,
    cookieCount: cookies.length,
    originCount: origins.length,
    originNames: origins
      .map((e) => String(e?.origin || '').trim())
      .filter(Boolean),
  }
}

export async function handleAuthSave(opts: {
  url?: string
  output?: string
  headless?: boolean
}): Promise<void> {
  const url = opts.url || 'https://ai.tangle.tools'
  const outPath = resolve(opts.output)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  // Dynamic import — playwright is a peer dep
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  console.log(`${chalk.cyan('Opening:')} ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })

  console.log('')
  console.log('Log in manually in the opened browser window.')
  console.log(`When done, press ${chalk.bold('Enter')} here to save storage state.`)
  console.log(`Output: ${chalk.dim(outPath)}`)

  const rl = readline.createInterface({ input: stdin, output: stdout })
  await rl.question('Press Enter after login is complete... ')
  rl.close()

  await context.storageState({ path: outPath })
  await browser.close()

  console.log(`${chalk.green('✓')} Saved storage state: ${outPath}`)
  console.log(`${chalk.dim('Verify:')} bad auth check ${outPath}`)
  console.log(`${chalk.dim('Use:')} bad run --storage-state ${outPath} --goal "..." --url "..."`)
}

// ── auth login — headless programmatic login for CI ──

interface FillDirective {
  selector: string
  value: string
}

function parseFillArg(raw: string): FillDirective {
  // "selector=value" or "name:field=value" (shorthand for [name="field"])
  const eqIdx = raw.indexOf('=')
  if (eqIdx === -1) throw new Error(`Invalid --fill format: "${raw}". Expected "selector=value" or "name:field=value".`)
  const left = raw.slice(0, eqIdx).trim()
  const value = raw.slice(eqIdx + 1)
  // Shorthand: "email=foo" → input[name="email"], input[type="email"], or #email
  const selector = left.includes('[') || left.includes('#') || left.includes('.')
    ? left
    : `input[name="${left}"], input[type="${left}"], textarea[name="${left}"], #${left}`
  return { selector, value }
}

interface CookieDirective {
  name: string
  value: string
  domain: string
  path: string
}

function parseCookieArg(raw: string, url: string): CookieDirective {
  // "name=value" — domain inferred from --url
  const eqIdx = raw.indexOf('=')
  if (eqIdx === -1) throw new Error(`Invalid --cookie format: "${raw}". Expected "name=value".`)
  const domain = new URL(url).hostname
  return {
    name: raw.slice(0, eqIdx),
    value: raw.slice(eqIdx + 1),
    domain,
    path: '/',
  }
}

export async function handleAuthLogin(opts: {
  url?: string
  output?: string
  fill?: string[]
  cookie?: string[]
  waitFor?: string
  waitTimeout?: number
  headless?: boolean
}): Promise<void> {
  const url = opts.url
  if (!url) {
    throw new Error('--url is required for auth login')
  }

  const outPath = resolve(opts.output)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const headless = opts.headless ?? true
  const waitTimeout = opts.waitTimeout ?? 30_000
  const fills = (opts.fill || []).map(parseFillArg)
  const cookies = (opts.cookie || []).map((c) => parseCookieArg(c, url))

  if (fills.length === 0 && cookies.length === 0) {
    throw new Error('auth login requires --fill and/or --cookie. Use "auth save" for interactive login.')
  }

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()

  try {
    // Inject cookies before navigation if provided
    if (cookies.length > 0) {
      console.log(`${chalk.cyan('Injecting')} ${cookies.length} cookie(s)`)
      await context.addCookies(cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      })))
    }

    console.log(`${chalk.cyan('Navigating:')} ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    // Fill form fields
    for (const { selector, value } of fills) {
      const el = page.locator(selector).first()
      await el.waitFor({ state: 'visible', timeout: 10_000 })
      await el.fill(value)
      console.log(`${chalk.dim('Filled:')} ${selector.length > 60 ? selector.slice(0, 57) + '...' : selector}`)
    }

    // Submit: press Enter on the last filled field, or click a submit button
    if (fills.length > 0) {
      const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first()
      const hasSubmit = await submitBtn.isVisible().catch(() => false)
      if (hasSubmit) {
        await submitBtn.click()
        console.log(`${chalk.dim('Clicked:')} submit button`)
      } else {
        await page.keyboard.press('Enter')
        console.log(`${chalk.dim('Pressed:')} Enter`)
      }
    }

    // Wait for success signal
    if (opts.waitFor) {
      const wf = opts.waitFor
      if (wf.startsWith('url:')) {
        // Wait for URL pattern: "url:*/dashboard*"
        const pattern = wf.slice(4)
        console.log(`${chalk.dim('Waiting for URL:')} ${pattern}`)
        await page.waitForURL(pattern, { timeout: waitTimeout })
      } else {
        // Wait for selector
        console.log(`${chalk.dim('Waiting for:')} ${wf}`)
        await page.waitForSelector(wf, { state: 'visible', timeout: waitTimeout })
      }
    } else {
      // Default: wait for navigation to settle
      console.log(`${chalk.dim('Waiting for navigation to settle...')}`)
      await page.waitForLoadState('networkidle', { timeout: waitTimeout }).catch(() => {
        // networkidle can be flaky — fall back to just waiting a bit
      })
      // Give SPAs time to redirect after auth
      await page.waitForTimeout(2_000)
    }

    await context.storageState({ path: outPath })
    const state = validate(outPath)

    console.log(`${chalk.green('✓')} Saved storage state: ${outPath}`)
    console.log(`  cookies: ${state.cookieCount}, origins: ${state.originCount}`)
    console.log(`  final URL: ${page.url()}`)
  } finally {
    await browser.close()
  }
}

export async function handleAuthCheck(opts: {
  path?: string
  origin?: string
}): Promise<void> {
  const target = resolve(opts.path)
  const state = validate(target)
  const expectedOrigin = opts.origin || ''

  console.log(`${chalk.cyan('Storage state:')} ${state.path}`)
  console.log(`  cookies: ${state.cookieCount}`)
  console.log(`  origins: ${state.originCount}`)
  for (const origin of state.originNames.slice(0, 10)) {
    console.log(`  origin:  ${origin}`)
  }

  if (expectedOrigin) {
    const found = state.originNames.some((o) => o.includes(expectedOrigin))
    if (!found) {
      console.error(`${chalk.red('✗')} Expected origin not found: ${expectedOrigin}`)
      process.exit(1)
    }
    console.log(`${chalk.green('✓')} Origin matched: ${expectedOrigin}`)
  } else {
    console.log(`${chalk.green('✓')} Valid`)
  }
}
