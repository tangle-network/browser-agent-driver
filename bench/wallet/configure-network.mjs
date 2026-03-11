#!/usr/bin/env node

/**
 * Configure MetaMask to use a custom RPC for Ethereum Mainnet (chain 0x1).
 *
 * Strategy: ADD a new type=custom endpoint alongside the existing Infura one.
 * MetaMask requires networkClientId "mainnet" to remain type=infura — changing
 * it breaks MetaMask's initialization. Instead, we add a new endpoint with a
 * unique networkClientId and set it as the default.
 *
 * Chrome must NOT be running when this script executes (LevelDB lock).
 *
 * Usage:
 *   node bench/wallet/configure-network.mjs
 *   node bench/wallet/configure-network.mjs --rpc-url http://127.0.0.1:8545
 *   node bench/wallet/configure-network.mjs --restore
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ClassicLevel } from 'classic-level'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1 || idx === argv.length - 1) return fallback
  return argv[idx + 1]
}
const hasFlag = (name) => argv.includes(`--${name}`)

const profileDir = path.resolve(rootDir, getArg('profile', './.agent-wallet-profile'))
const rpcUrl = getArg('rpc-url', 'http://127.0.0.1:8545')
const restore = hasFlag('restore')

if (!fs.existsSync(profileDir)) {
  console.error(`Profile not found: ${profileDir}. Run: pnpm wallet:onboard`)
  process.exit(1)
}

const extStorageDir = path.join(profileDir, 'Default/Local Extension Settings')
if (!fs.existsSync(extStorageDir)) {
  console.error(`Extension storage not found: ${extStorageDir}`)
  process.exit(1)
}

const extIds = fs.readdirSync(extStorageDir).filter(d =>
  fs.statSync(path.join(extStorageDir, d)).isDirectory()
)
if (extIds.length === 0) {
  console.error('No extension storage directories found')
  process.exit(1)
}

// Remove Chrome singleton locks
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
  const p = path.join(profileDir, f)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

const extensionId = extIds[0]
const dbPath = path.join(extStorageDir, extensionId)

console.log('=== MetaMask Network Configuration (LevelDB) ===')
console.log(`Extension: ${extensionId}`)
console.log(`Target:    ${restore ? 'RESTORE Infura' : rpcUrl}`)

const db = new ClassicLevel(dbPath, { keyEncoding: 'utf8', valueEncoding: 'utf8' })

try {
  await db.open()

  const nc = JSON.parse(await db.get('NetworkController'))
  const chain1 = nc.networkConfigurationsByChainId?.['0x1']

  if (!chain1) {
    console.error('Chain 0x1 not found')
    process.exit(1)
  }

  const endpoints = chain1.rpcEndpoints || []
  console.log(`\nEndpoints (before):`)
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i]
    const marker = i === chain1.defaultRpcEndpointIndex ? ' << DEFAULT' : ''
    console.log(`  [${i}] ${e.type} | ${e.networkClientId} | ${e.url}${marker}`)
  }

  if (restore) {
    // Remove any custom endpoints we added, keep only the Infura mainnet
    chain1.rpcEndpoints = endpoints.filter(e => e.networkClientId === 'mainnet')
    chain1.defaultRpcEndpointIndex = 0
    nc.selectedNetworkClientId = 'mainnet'

    // Reset domain mappings to mainnet
    try {
      const snc = JSON.parse(await db.get('SelectedNetworkController'))
      for (const d of Object.keys(snc.domains || {})) snc.domains[d] = 'mainnet'
      await db.put('SelectedNetworkController', JSON.stringify(snc))
    } catch {}

    // Clean up networksMetadata (remove UUID-based entries)
    if (nc.networksMetadata) {
      for (const k of Object.keys(nc.networksMetadata)) {
        if (k.includes('-')) delete nc.networksMetadata[k]
      }
    }

    console.log(`\nRestored: removed custom endpoints, selected=mainnet`)
  } else {
    // Remove any previously added custom endpoints
    chain1.rpcEndpoints = endpoints.filter(e => e.type !== 'custom')

    // Add new custom endpoint for Anvil
    const clientId = crypto.randomUUID()
    chain1.rpcEndpoints.push({
      networkClientId: clientId,
      type: 'custom',
      url: rpcUrl,
    })
    chain1.defaultRpcEndpointIndex = chain1.rpcEndpoints.length - 1
    nc.selectedNetworkClientId = clientId

    // Add networksMetadata for the new client
    nc.networksMetadata = nc.networksMetadata || {}
    nc.networksMetadata[clientId] = { EIPS: {}, status: 'unknown' }

    // Update domain mappings
    try {
      const snc = JSON.parse(await db.get('SelectedNetworkController'))
      for (const d of Object.keys(snc.domains || {})) snc.domains[d] = clientId
      await db.put('SelectedNetworkController', JSON.stringify(snc))
    } catch {}

    console.log(`\nAdded custom endpoint: ${clientId}`)
  }

  await db.put('NetworkController', JSON.stringify(nc))

  // Clear cached balances
  try {
    await db.put('AccountTracker', JSON.stringify({ accountsByChainId: { '0x1': {} } }))
    console.log('Cleared cached account balances')
  } catch {}

  // Fix onboarding state
  try {
    const oc = JSON.parse(await db.get('OnboardingController'))
    oc.completedOnboarding = true
    oc.seedPhraseBackedUp = true
    await db.put('OnboardingController', JSON.stringify(oc))
  } catch {}
  try {
    const asc = JSON.parse(await db.get('AppStateController'))
    asc.showOnboarding = false
    asc.onBoardingDate = Date.now()
    await db.put('AppStateController', JSON.stringify(asc))
  } catch {}

  // Verify
  const verify = JSON.parse(await db.get('NetworkController'))
  const verifyChain = verify.networkConfigurationsByChainId['0x1']
  console.log(`\nEndpoints (after):`)
  for (let i = 0; i < verifyChain.rpcEndpoints.length; i++) {
    const e = verifyChain.rpcEndpoints[i]
    const marker = i === verifyChain.defaultRpcEndpointIndex ? ' << DEFAULT' : ''
    console.log(`  [${i}] ${e.type} | ${e.networkClientId} | ${e.url}${marker}`)
  }
  console.log(`Selected: ${verify.selectedNetworkClientId}`)

  const activeEndpoint = verifyChain.rpcEndpoints[verifyChain.defaultRpcEndpointIndex]
  if (!restore && activeEndpoint.url === rpcUrl && activeEndpoint.type === 'custom') {
    console.log(`\n✓ Custom RPC endpoint active: ${rpcUrl}`)
  } else if (restore) {
    console.log(`\n✓ Restored to Infura mainnet`)
  } else {
    console.error('\n✗ Verification failed!')
    process.exit(1)
  }
} finally {
  await db.close()
}

// Clear Chrome caches for clean startup
for (const d of ['Cache', 'Code Cache', 'Service Worker']) {
  const p = path.join(profileDir, 'Default', d)
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
}
console.log('Cleared Chrome caches')
console.log('\nDone.')
