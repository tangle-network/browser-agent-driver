#!/usr/bin/env node

/**
 * Wallet flow validation runner.
 *
 * Exercises wallet connect/approve/sign flows against live DeFi apps
 * using the browser-agent-driver wallet automation module.
 *
 * Prerequisites:
 *   1. MetaMask extension: pnpm wallet:setup
 *   2. MetaMask onboarded: pnpm wallet:onboard
 *   3. OPENAI_API_KEY in .env
 *   4. For funded tests: Anvil fork running (pnpm wallet:anvil)
 *
 * Usage:
 *   node bench/wallet/run-wallet-validation.mjs                    # all cases
 *   node bench/wallet/run-wallet-validation.mjs --suite defi       # DeFi-only
 *   node bench/wallet/run-wallet-validation.mjs --suite tangle     # Tangle-only
 *   node bench/wallet/run-wallet-validation.mjs --anvil            # auto-start Anvil fork
 *   node bench/wallet/run-wallet-validation.mjs --dry-run          # print plan only
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

const argv = process.argv.slice(2)
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  if (idx === argv.length - 1) return 'true'
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const suite = getArg('suite', 'all')
const extensionPath = path.resolve(getArg('extension', './extensions/metamask'))
const userDataDir = path.resolve(getArg('user-data-dir', './.agent-wallet-profile'))
const chainId = getArg('chain-id', '1')
const chainRpc = getArg('chain-rpc', 'http://127.0.0.1:8545')
const autoAnvil = hasFlag('anvil')
const model = getArg('model', 'gpt-5.4')
const outDir = path.resolve(getArg('out', `./agent-results/wallet-${Date.now()}`))
const dryRun = hasFlag('dry-run')

const suiteFiles = {
  defi: path.join(__dirname, 'cases-local-anvil.json'),
  tangle: path.join(__dirname, 'cases-tangle.json'),
}

function loadCases() {
  if (suite === 'all') {
    return Object.entries(suiteFiles).flatMap(([name, filePath]) => {
      if (!fs.existsSync(filePath)) {
        console.warn(`⚠ Suite file missing: ${filePath}`)
        return []
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    })
  }
  const filePath = suiteFiles[suite]
  if (!filePath) {
    console.error(`Unknown suite: ${suite}. Options: ${Object.keys(suiteFiles).join(', ')}, all`)
    process.exit(1)
  }
  if (!fs.existsSync(filePath)) {
    console.error(`Suite file not found: ${filePath}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

function validatePrerequisites() {
  const issues = []

  if (!fs.existsSync(extensionPath)) {
    issues.push(`Extension not found at ${extensionPath}`)
    issues.push('  Run: pnpm wallet:setup')
  }

  if (!process.env.OPENAI_API_KEY) {
    // Check .env file — the CLI loads it at runtime
    const envFile = path.join(rootDir, '.env')
    if (fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf-8').includes('OPENAI_API_KEY')) {
      // Key is in .env, CLI will pick it up
    } else {
      issues.push('OPENAI_API_KEY not set (not in env or .env)')
    }
  }

  return issues
}

const cases = loadCases()

console.log('=== Wallet Flow Validation ===')
console.log(`Suite:     ${suite} (${cases.length} cases)`)
console.log(`Extension: ${extensionPath}`)
console.log(`Profile:   ${userDataDir}`)
console.log(`Chain:     ${chainId} → ${chainRpc}`)
console.log(`Model:     ${model}`)
console.log(`Output:    ${outDir}`)
console.log()

const issues = validatePrerequisites()
if (issues.length > 0) {
  console.log('Prerequisites:')
  for (const issue of issues) {
    console.log(`  ✗ ${issue}`)
  }
  console.log()
  if (!dryRun) {
    console.error('Fix prerequisites before running. Use --dry-run to see plan anyway.')
    process.exit(1)
  }
}

console.log('Cases:')
for (const c of cases) {
  console.log(`  ${c.id.padEnd(32)} ${c.startUrl}`)
}
console.log()

if (dryRun) {
  console.log('(dry run — exiting)')
  process.exit(0)
}

// Auto-start Anvil if requested
if (autoAnvil) {
  console.log('Starting Anvil fork...')
  try {
    execSync(`node ${path.join(__dirname, 'setup-anvil.mjs')}`, {
      cwd: rootDir,
      stdio: 'inherit',
      timeout: 60_000,
    })
  } catch (e) {
    console.error('Anvil setup failed:', e.message)
    process.exit(1)
  }
  console.log()
}

// Write combined cases to a temp file for the CLI
const tmpCasesPath = path.join(outDir, 'cases.json')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(tmpCasesPath, JSON.stringify(cases, null, 2))

const cliArgs = [
  path.join(rootDir, 'dist/cli.js'), 'run',
  '--cases', tmpCasesPath,
  '--model', model,
  '--wallet',
  '--extension', extensionPath,
  '--user-data-dir', userDataDir,
  '--wallet-auto-approve',
  '--wallet-preflight',
  '--wallet-chain-id', chainId,
  '--wallet-chain-rpc-url', chainRpc,
  '--no-headless',
  '--concurrency', '1',
  '--timeout', '300000',
  '--memory',
  '--memory-dir', '.agent-memory/wallet',
  '--sink', outDir,
]

if (process.env.AGENT_WALLET_PASSWORD) {
  cliArgs.push('--wallet-password', process.env.AGENT_WALLET_PASSWORD)
}


console.log(`Running: node ${cliArgs.join(' ')}`)
console.log()

const child = spawn('node', cliArgs, {
  cwd: rootDir,
  stdio: 'inherit',
  env: { ...process.env },
})

child.on('exit', (code) => {
  console.log()
  console.log(`=== Wallet validation ${code === 0 ? 'PASSED' : 'FINISHED'} (exit ${code}) ===`)
  console.log(`Results: ${outDir}`)
  process.exit(code ?? 1)
})
