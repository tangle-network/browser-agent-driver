#!/usr/bin/env node

/**
 * Start Anvil forked from mainnet and seed the test wallet with assets.
 *
 * Test wallet: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
 *   (derived from: test test test test test test test test test test test junk)
 *
 * Seeds:
 *   - 100 ETH
 *   - 10,000 USDC
 *   - 10 WETH
 *
 * Usage:
 *   node bench/wallet/setup-anvil.mjs                              # start and seed
 *   node bench/wallet/setup-anvil.mjs --fork-url https://...       # custom RPC
 *   node bench/wallet/setup-anvil.mjs --stop                       # stop running Anvil
 *   node bench/wallet/setup-anvil.mjs --status                     # check if running
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const pidFile = path.join(rootDir, '.anvil.pid')

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1 || idx === argv.length - 1) return fallback
  return argv[idx + 1]
}

const TEST_WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ANVIL_PORT = parseInt(getArg('port', '8545'), 10)
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`

// Public RPCs for forking (no API key needed).
// drpc.org first — fast and handles complex calls well.
// publicnode and 1rpc have historical state retention issues.
const DEFAULT_FORK_URLS = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.llamarpc.com',
]

function isAnvilRunning() {
  if (!fs.existsSync(pidFile)) return false
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    fs.unlinkSync(pidFile)
    return false
  }
}

function stopAnvil() {
  if (!fs.existsSync(pidFile)) {
    console.log('No Anvil PID file found.')
    return
  }
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Stopped Anvil (PID ${pid})`)
  } catch {
    console.log(`Anvil PID ${pid} not running`)
  }
  fs.unlinkSync(pidFile)
}

if (argv.includes('--stop')) {
  stopAnvil()
  process.exit(0)
}

if (argv.includes('--status')) {
  if (isAnvilRunning()) {
    const pid = fs.readFileSync(pidFile, 'utf-8').trim()
    console.log(`Anvil running (PID ${pid}) at ${ANVIL_RPC}`)
  } else {
    console.log('Anvil not running')
  }
  process.exit(0)
}

if (isAnvilRunning()) {
  console.log('Anvil already running — seeding accounts...')
} else {
  // Find a working fork URL
  const forkUrl = getArg('fork-url', null)
  let selectedForkUrl = forkUrl

  if (!selectedForkUrl) {
    for (const url of DEFAULT_FORK_URLS) {
      try {
        const result = execSync(
          `cast block-number --rpc-url ${url}`,
          { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim()
        if (parseInt(result, 10) > 0) {
          selectedForkUrl = url
          console.log(`Fork RPC: ${url} (block ${result})`)
          break
        }
      } catch {
        continue
      }
    }
  }

  if (!selectedForkUrl) {
    console.error('No working RPC endpoint found. Pass --fork-url <url>')
    process.exit(1)
  }

  console.log('Starting Anvil...')
  const anvil = spawn('anvil', [
    '--fork-url', selectedForkUrl,
    '--chain-id', '1',
    '--port', String(ANVIL_PORT),
    '--accounts', '1',
    '--mnemonic', 'test test test test test test test test test test test junk',
    '--block-time', '2',
    '--silent',
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  fs.writeFileSync(pidFile, String(anvil.pid))
  anvil.unref()

  // Wait for Anvil to be ready
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      const block = execSync(
        `cast block-number --rpc-url ${ANVIL_RPC}`,
        { encoding: 'utf-8', timeout: 3_000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim()
      if (parseInt(block, 10) > 0) {
        ready = true
        console.log(`Anvil ready at ${ANVIL_RPC} (block ${block}, PID ${anvil.pid})`)
        break
      }
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  if (!ready) {
    console.error('Anvil failed to start')
    stopAnvil()
    process.exit(1)
  }

  // Wait for Anvil to fully initialize (fork state loaded)
  await new Promise(r => setTimeout(r, 3000))
}

// Seed test wallet
console.log(`\nSeeding ${TEST_WALLET}...`)

function cast(args, timeoutMs = 30_000) {
  return execSync(`cast ${args} --rpc-url ${ANVIL_RPC}`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

// Set ETH balance to 100 ETH
try {
  cast(`rpc anvil_setBalance ${TEST_WALLET} 0x56BC75E2D63100000`)
  const bal = cast(`balance ${TEST_WALLET} --ether`)
  console.log(`  ETH: ${bal}`)
} catch (e) {
  console.error(`  ETH seeding failed: ${e.message}`)
}

// Wrap ETH → WETH by depositing via the WETH contract
try {
  cast(`send ${WETH} --value 10ether --from ${TEST_WALLET} --unlocked "deposit()"`)
  const wethBal = cast(`call ${WETH} "balanceOf(address)(uint256)" ${TEST_WALLET}`)
  const wethNum = Number(BigInt(wethBal.split('[')[0].trim()) / BigInt(1e18))
  console.log(`  WETH: ${wethNum}`)
} catch (e) {
  console.error(`  WETH seeding failed: ${e.message}`)
}

// Seed USDC (6 decimals) via slot manipulation — faster than impersonation
// USDC balanceOf mapping is at slot 9
try {
  // Compute storage slot for balanceOf[TEST_WALLET]
  const slot = execSync(
    `cast index address ${TEST_WALLET} 9`,
    { encoding: 'utf-8', timeout: 5_000 },
  ).trim()
  // 10,000 USDC = 10000 * 1e6 = 10000000000 = 0x2540BE400
  cast(`rpc anvil_setStorageAt ${USDC} ${slot} 0x00000000000000000000000000000000000000000000000000000002540BE400`)
  const usdcBal = cast(`call ${USDC} "balanceOf(address)(uint256)" ${TEST_WALLET}`)
  const usdcNum = Number(BigInt(usdcBal.split('[')[0].trim()) / BigInt(1e6))
  console.log(`  USDC: ${usdcNum}`)
} catch (e) {
  console.error(`  USDC seeding failed: ${e.message}`)
}

// Pre-warm: cache contract state so Anvil doesn't need upstream later.
// These are the contracts Aave V3 queries for the supply flow.
console.log('\nPre-warming contract state...')
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const AAVE_UI_POOL_DATA = '0xe3dff4052f0bf6134acb73beae8fe2317d71f047'
const AAVE_INCENTIVES = '0x56b7a1012765c285afac8b8f25c69bf10ccfe978'
const AAVE_WALLET_BAL = '0xc7be5307ba715ce89b152f3df0658295b3dba8e2'
const AAVE_POOL_PROVIDER = '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e'
const WETH_GATEWAY = '0xD322A49006FC828F9B5B37Ab215F99B4E5caB19C'
const warmCalls = [
  // Pool data provider — getReservesData(provider)
  `call ${AAVE_UI_POOL_DATA} "0x976fafc5000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}"`,
  // Incentives data
  `call ${AAVE_INCENTIVES} "0xec489c21000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}"`,
  `call ${AAVE_INCENTIVES} "0x6f90b9d1000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}"`,
  // User reserve data
  `call ${AAVE_UI_POOL_DATA} "0x799bdcf5000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}000000000000000000000000${TEST_WALLET.slice(2).toLowerCase()}"`,
  // Wallet balance provider
  `call ${AAVE_WALLET_BAL} "0x02405343000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}000000000000000000000000${TEST_WALLET.slice(2).toLowerCase()}"`,
  // User incentives
  `call ${AAVE_INCENTIVES} "0x51974cc0000000000000000000000000${AAVE_POOL_PROVIDER.slice(2).toLowerCase()}000000000000000000000000${TEST_WALLET.slice(2).toLowerCase()}"`,
  // Supply simulation (ETH via WETHGateway)
  `estimate ${WETH_GATEWAY} "depositETH(address,address,uint16)" ${AAVE_POOL} ${TEST_WALLET} 0 --value 0.01ether --from ${TEST_WALLET}`,
]
let warmed = 0
for (const call of warmCalls) {
  try {
    cast(call, 60_000)
    warmed++
    process.stdout.write('.')
  } catch (e) {
    process.stdout.write('x')
  }
}
console.log()
console.log(`  Warmed: ${warmed}/${warmCalls.length}`)

console.log(`\n✓ Anvil fork ready at ${ANVIL_RPC}`)
console.log(`  Chain ID: 1 (mainnet fork)`)
console.log(`  Wallet: ${TEST_WALLET}`)
console.log(`  PID file: ${pidFile}`)
console.log(`  Stop: node bench/wallet/setup-anvil.mjs --stop`)
