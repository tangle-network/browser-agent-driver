#!/usr/bin/env npx tsx
/**
 * Live CAPTCHA solving bench — exercises solveCaptcha() on Google's demo page.
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx bench/captcha-bench.ts [--model gpt-4.1]
 */

import { chromium } from 'playwright'
import { solveCaptcha } from '../src/captcha.js'

const MODEL = process.argv.find(a => a.startsWith('--model='))?.split('=')[1]
  || process.argv[process.argv.indexOf('--model') + 1]
  || 'gpt-4.1'

async function main() {
  console.log(`CAPTCHA bench — model: ${MODEL}\n`)

  const { createOpenAI } = await import('@ai-sdk/openai')
  const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(MODEL)

  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()

  await page.goto('https://www.google.com/recaptcha/api2/demo', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  const result = await solveCaptcha(page, model, { maxAttempts: 5 })
  console.log(`\n${result.success ? 'PASS' : 'FAIL'} — ${result.attempts} attempts, ${result.durationMs}ms`)
  if (result.error) console.log(`  error: ${result.error}`)
  for (const a of result.attemptLog) {
    console.log(`  attempt: tiles=[${a.tilesClicked}] refused=${a.modelRefused} ${a.durationMs}ms — "${a.instruction}"`)
  }

  if (result.success) {
    await page.locator('#recaptcha-demo-submit').click().catch(() => {})
    await page.waitForTimeout(2000)
    console.log(`  result page: ${await page.title()}`)
  }

  await browser.close()
  process.exit(result.success ? 0 : 1)
}

main().catch(console.error)
