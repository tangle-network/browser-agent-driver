#!/usr/bin/env node

/**
 * Download and unpack MetaMask extension for wallet automation.
 *
 * Fetches the latest MetaMask release from GitHub, extracts to ./extensions/metamask/.
 * If already present, prints version and exits.
 *
 * Usage:
 *   node bench/wallet/setup-extension.mjs
 *   node bench/wallet/setup-extension.mjs --force          # re-download
 *   node bench/wallet/setup-extension.mjs --wallet rabby   # Rabby instead
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const wallet = argv.includes('--wallet') ? argv[argv.indexOf('--wallet') + 1] : 'metamask'

const extensionsDir = path.join(rootDir, 'extensions')
const targetDir = path.join(extensionsDir, wallet)

const SOURCES = {
  metamask: {
    repo: 'MetaMask/metamask-extension',
    asset: 'metamask-chrome',
    manifestCheck: 'MetaMask',
    manual: [
      '1. gh release download --repo MetaMask/metamask-extension --pattern "metamask-chrome-*.zip"',
      '2. unzip metamask-chrome-*.zip -d ./extensions/metamask/',
      '3. Verify manifest.json exists at ./extensions/metamask/manifest.json',
    ],
  },
  rabby: {
    repo: 'nicedeveloper/nicedeveloper.github.io',
    asset: 'rabby-chrome',
    manifestCheck: 'Rabby',
    manual: [
      '1. Go to chrome://extensions in Chrome',
      '2. Enable Developer Mode',
      '3. Find Rabby Wallet, note its ID',
      '4. Copy extension directory to ./extensions/rabby/',
    ],
  },
}

const source = SOURCES[wallet]
if (!source) {
  console.error(`Unknown wallet: ${wallet}. Options: ${Object.keys(SOURCES).join(', ')}`)
  process.exit(1)
}

function checkExisting() {
  const manifest = path.join(targetDir, 'manifest.json')
  if (!fs.existsSync(manifest)) return null
  try {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf-8'))
    return { name: data.name, version: data.version }
  } catch {
    return null
  }
}

const existing = checkExisting()
if (existing && !force) {
  console.log(`${wallet} already installed: ${existing.name} v${existing.version}`)
  console.log(`Path: ${targetDir}`)
  console.log('Use --force to re-download.')
  process.exit(0)
}

console.log(`=== ${wallet} Extension Setup ===`)
console.log()

// Try GitHub release download
let downloaded = false
try {
  console.log(`Checking GitHub releases: ${source.repo}...`)
  const releasesJson = execSync(
    `gh release list --repo ${source.repo} --limit 5 --json tagName,name`,
    { encoding: 'utf-8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const releases = JSON.parse(releasesJson)

  if (releases.length > 0) {
    const tag = releases[0].tagName
    console.log(`Latest release: ${tag}`)

    const tmpZip = path.join(extensionsDir, `${wallet}-download.zip`)
    fs.mkdirSync(extensionsDir, { recursive: true })

    try {
      execSync(
        `gh release download ${tag} --repo ${source.repo} --pattern "*${source.asset}*" --output ${tmpZip}`,
        { timeout: 60_000, stdio: 'inherit' },
      )

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true })
      }
      fs.mkdirSync(targetDir, { recursive: true })

      execSync(`unzip -o -q ${tmpZip} -d ${targetDir}`, { timeout: 30_000, stdio: 'inherit' })
      fs.unlinkSync(tmpZip)
      downloaded = true
      console.log(`Extracted to ${targetDir}`)
    } catch (e) {
      console.warn(`Download failed: ${e.message}`)
      if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip)
    }
  }
} catch {
  // gh CLI not available or repo not found — fall through to manual instructions
}

if (!downloaded) {
  console.log()
  console.log(`Automatic download not available. Manual setup:`)
  console.log()
  for (const step of source.manual) {
    console.log(`  ${step}`)
  }
  console.log()
  console.log(`Target directory: ${targetDir}`)
  console.log('The directory must contain manifest.json at its root.')
  process.exit(1)
}

const info = checkExisting()
if (info) {
  console.log()
  console.log(`Installed: ${info.name} v${info.version}`)
  console.log(`Path: ${targetDir}`)
} else {
  console.warn('Extension extracted but manifest.json not found at root.')
  console.warn('The extension may be nested in a subdirectory — check and flatten if needed.')
  process.exit(1)
}
