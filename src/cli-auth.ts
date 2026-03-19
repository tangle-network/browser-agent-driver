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
