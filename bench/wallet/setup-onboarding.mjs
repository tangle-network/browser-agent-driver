#!/usr/bin/env node

/**
 * Automates MetaMask 13.x onboarding via SRP import.
 *
 * Usage:
 *   node bench/wallet/setup-onboarding.mjs
 *   node bench/wallet/setup-onboarding.mjs --reset
 *   node bench/wallet/setup-onboarding.mjs --password MyPass123!
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1 || idx === argv.length - 1) return fallback
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const extensionPath = path.resolve(rootDir, getArg('extension', './extensions/metamask'))
const profileDir = path.resolve(rootDir, getArg('profile', './.agent-wallet-profile'))
const password = getArg('password', 'TangleLocal123!')
const reset = hasFlag('reset')
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
  console.error(`Extension not found: ${extensionPath}`)
  process.exit(1)
}

if (reset && fs.existsSync(profileDir)) {
  fs.rmSync(profileDir, { recursive: true })
}

console.log('=== MetaMask Onboarding ===')
console.log(`Profile: ${profileDir}`)

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--disable-blink-features=AutomationControlled',
  ],
  viewport: { width: 1280, height: 800 },
})

let extensionId
try {
  const workers = context.serviceWorkers()
  extensionId = workers.length > 0
    ? new URL(workers[0].url()).host
    : new URL((await context.waitForEvent('serviceworker', { timeout: 15_000 })).url()).host
} catch {
  console.error('MetaMask service worker not detected')
  await context.close()
  process.exit(1)
}
console.log(`Extension: ${extensionId}`)

const page = context.pages()[0] || await context.newPage()
await page.goto(`chrome-extension://${extensionId}/home.html`)
await page.waitForTimeout(2500)

// Helpers
async function clickBtn(textPatterns, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const text of textPatterns) {
      const btn = page.getByRole('button', { name: text })
      if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        await btn.click({ timeout: 3_000 }).catch(() => null)
        console.log(`  ✓ ${label}`)
        await page.waitForTimeout(800)
        return true
      }
    }
    // Also try link role
    for (const text of textPatterns) {
      const link = page.getByRole('link', { name: text })
      if (await link.isVisible().catch(() => false)) {
        await link.click({ timeout: 3_000 }).catch(() => null)
        console.log(`  ✓ ${label}`)
        await page.waitForTimeout(800)
        return true
      }
    }
    await page.waitForTimeout(300)
  }
  console.log(`  - ${label} (not found)`)
  return false
}

async function screenshot(name) {
  const p = path.join(rootDir, `mm-${name}.png`)
  await page.screenshot({ path: p })
  console.log(`  Screenshot: mm-${name}.png`)
}

// Check if already onboarded (unlock screen or main wallet page)
// Wait for either the unlock screen or the onboarding welcome
await page.waitForTimeout(3000)
const unlockBtn = page.getByRole('button', { name: 'Unlock' })
const hasUnlock = await unlockBtn.isVisible({ timeout: 3_000 }).catch(() => false)

if (hasUnlock) {
  console.log('Already onboarded — unlocking.')
  await page.locator('input[type="password"], input[placeholder*="password" i]').first().fill(password)
  await unlockBtn.click()
  await page.waitForTimeout(3000)
  // Dismiss any post-unlock modals
  for (const t of [['Got it', 'Got it!'], ['No thanks'], ['Done']]) {
    await clickBtn(t, `Dismiss: ${t[0]}`, 2_000)
  }
  console.log('\n✓ Wallet unlocked and ready.')
  await context.close()
  process.exit(0)
}

const bodyText0 = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '')
if ((bodyText0.includes('Account') || bodyText0.includes('ETH')) && !page.url().includes('onboarding')) {
  console.log('Already onboarded and unlocked.')
  await context.close()
  process.exit(0)
}

// === STEP 1: Welcome ===
console.log('Step 1: Welcome')
await clickBtn(['I have an existing wallet'], 'Import existing wallet')

// === STEP 2: Auth method choice (MM 13.x) ===
// Shows "Sign in with Google / Apple" or "Import using Secret Recovery Phrase"
await page.waitForTimeout(2000)
console.log('Step 2: Choose import method')
await clickBtn(
  ['Import using Secret Recovery Phrase', 'Use Secret Recovery Phrase', 'Secret Recovery Phrase'],
  'Import using SRP',
)

// === STEP 2b: Analytics consent ===
await page.waitForTimeout(1500)
console.log('Step 2b: Analytics')
await clickBtn(['No thanks', 'No Thanks', "I don't agree"], 'Decline analytics')

// === STEP 3: SRP Input ===
await page.waitForTimeout(2000)
console.log('Step 3: Secret Recovery Phrase')

// Wait for the Import page
await page.getByText('Import a wallet').or(page.getByText('Secret Recovery Phrase'))
  .waitFor({ timeout: 10_000 }).catch(() => null)
await page.waitForTimeout(1000)

// Debug: dump the page's DOM structure around the SRP area using CDP
const cdp = await context.newCDPSession(page)

// Use CDP to find input elements that Playwright's locators might miss
const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true })

async function findNodesBySelector(selector) {
  try {
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector,
    })
    return nodeIds
  } catch {
    return []
  }
}

// Search for any focusable/editable element
const editable = await findNodesBySelector('[contenteditable]')
const textareas = await findNodesBySelector('textarea')
const inputs = await findNodesBySelector('input')
const divEditable = await findNodesBySelector('div[contenteditable="true"]')

console.log(`  CDP scan: contenteditable=${editable.length}, textarea=${textareas.length}, input=${inputs.length}, div[contenteditable]=${divEditable.length}`)

let filled = false

// Approach 1: Click the SRP input area by coordinate, then type character by character
// This is most reliable because it simulates real user interaction
const heading = page.getByText('Enter your Secret Recovery Phrase')
const hBox = await heading.boundingBox().catch(() => null)
if (hBox) {
  // Click in the center of the textarea area (below the heading)
  const x = hBox.x + hBox.width / 2
  const y = hBox.y + hBox.height + 100
  await page.mouse.click(x, y)
  await page.waitForTimeout(500)
  // Type slowly to let React process each keystroke
  await page.keyboard.type(TEST_MNEMONIC, { delay: 20 })
  console.log('  ✓ Typed SRP via coordinate click')
  filled = true
}

// Approach 2: CDP focus on textarea found via pierce
if (!filled && textareas.length > 0) {
  try {
    await cdp.send('DOM.focus', { nodeId: textareas[0] })
    await page.waitForTimeout(300)
    await page.keyboard.type(TEST_MNEMONIC, { delay: 20 })
    console.log('  ✓ Typed SRP via CDP focus')
    filled = true
  } catch (e) {
    console.log(`  - CDP focus failed: ${e.message}`)
  }
}

// Wait for Continue button to become enabled after SRP entry
if (filled) {
  console.log('  Waiting for Continue to enable...')
  await page.waitForTimeout(2000)
}

if (!filled) {
  console.log('  ✗ Failed to enter SRP')
  await screenshot('srp-stuck')
  await context.close()
  process.exit(1)
}

await page.waitForTimeout(1000)

// Click Continue
await clickBtn(['Continue', 'Confirm', 'Import'], 'Continue')

// === STEP 4: Create Password ===
await page.waitForTimeout(2000)
console.log('Step 4: Password')

// Wait for password inputs
const pwInput = page.locator('input[type="password"]').first()
await pwInput.waitFor({ timeout: 10_000 }).catch(() => null)

const pwCount = await page.locator('input[type="password"]').count()
console.log(`  Found ${pwCount} password field(s)`)

if (pwCount >= 2) {
  await page.locator('input[type="password"]').nth(0).fill(password)
  await page.locator('input[type="password"]').nth(1).fill(password)
  console.log('  ✓ Filled passwords')
} else if (pwCount === 1) {
  await pwInput.fill(password)
  console.log('  ✓ Filled password')
} else {
  console.log('  ✗ No password fields found')
  await screenshot('pw-stuck')
  await context.close()
  process.exit(1)
}

// Accept terms checkbox
const checkbox = page.locator('input[type="checkbox"]').first()
if (await checkbox.isVisible().catch(() => false)) {
  await checkbox.check().catch(async () => {
    await checkbox.click()
  })
  console.log('  ✓ Accepted terms')
}

// Click Import / Create
await clickBtn(['Import my wallet', 'Create', 'Import', 'Continue'], 'Submit')

// === STEP 5: Post-creation pages ===
await page.waitForTimeout(3000)
console.log('Step 5: Post-creation flow')

// Metametrics consent (appears after wallet creation in MM 13.x)
// Uncheck the usage data checkbox, then continue
const usageCheckbox = page.getByText('Gather basic usage data')
if (await usageCheckbox.isVisible({ timeout: 3_000 }).catch(() => false)) {
  // Uncheck "Gather basic usage data" if checked
  const checkbox = page.locator('input[type="checkbox"]').first()
  if (await checkbox.isChecked().catch(() => false)) {
    await checkbox.uncheck().catch(async () => await checkbox.click())
    console.log('  ✓ Unchecked usage data')
  }
}
await clickBtn(['Continue'], 'Continue (analytics)')
await page.waitForTimeout(2000)

// "Your wallet is ready" — button may appear disabled but we MUST click it
// to clear MetaMask's internal onboarding state
const openWalletBtn = page.getByRole('button', { name: 'Open wallet' })
const owVisible = await openWalletBtn.isVisible({ timeout: 5_000 }).catch(() => false)
if (owVisible) {
  // Wait for it to become enabled (MetaMask does background setup)
  console.log('  Waiting for Open wallet to enable...')
  for (let i = 0; i < 20; i++) {
    const enabled = await openWalletBtn.isEnabled().catch(() => false)
    if (enabled) break
    await page.waitForTimeout(1000)
  }
  // Force click even if still disabled — needed to clear onboarding state
  await openWalletBtn.click({ force: true, timeout: 5_000 }).catch(() => null)
  console.log('  ✓ Clicked Open wallet')
  await page.waitForTimeout(3000)
}

// If still on onboarding, navigate directly
if (page.url().includes('onboarding')) {
  console.log('  Force-navigating to home...')
  await page.goto(`chrome-extension://${extensionId}/home.html`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
}

// Dismiss any post-onboarding modals
for (const texts of [
  ['Got it', 'Got it!'],
  ['Next'],
  ['Done'],
  ['No thanks', 'No Thanks'],
  ['Continue'],
]) {
  await clickBtn(texts, `Dismiss: ${texts[0]}`, 2_000)
}

await page.waitForTimeout(1000)

const finalUrl = page.url()
const bodyText = await page.locator('body').innerText({ timeout: 3_000 }).catch(() => '')
const ready = bodyText.includes('Account') || bodyText.includes('ETH') || bodyText.includes('0x')

console.log(`\nFinal URL: ${finalUrl}`)
if (ready) {
  console.log('✓ MetaMask onboarding complete.')
  console.log(`  Profile: ${profileDir}`)
  console.log(`  Password: ${password}`)
  console.log('\nReady: pnpm wallet:validate')
} else {
  await screenshot('final')
  console.log('⚠ Onboarding may not be complete — check screenshot.')
}

await context.close()
