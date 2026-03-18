#!/usr/bin/env node

/**
 * WebArena setup — pull Docker images, start services, configure hostnames.
 *
 * Prerequisites:
 *   - Docker installed and running
 *   - ~50GB disk space (Docker images)
 *   - Ports 3000, 4399, 7770, 7780, 8023, 8888, 9999 available
 *
 * Usage:
 *   node bench/external/webarena/setup.mjs           # Pull images + start
 *   node bench/external/webarena/setup.mjs --start    # Start existing containers
 *   node bench/external/webarena/setup.mjs --stop     # Stop all containers
 *   node bench/external/webarena/setup.mjs --reset    # Stop + restart from clean images
 *   node bench/external/webarena/setup.mjs --status   # Check container status
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}

const HOST = getArg('host', 'localhost')

// WebArena Docker images (from the official repo)
const SERVICES = [
  {
    name: 'wa-shopping',
    image: 'ghcr.io/web-arena-x/shopping_final_0712',
    port: 7770,
    containerPort: 80,
    envKey: 'WA_SHOPPING',
  },
  {
    name: 'wa-shopping-admin',
    image: 'ghcr.io/web-arena-x/shopping_admin_final_0719',
    port: 7780,
    containerPort: 80,
    envKey: 'WA_SHOPPING_ADMIN',
  },
  {
    name: 'wa-forum',
    image: 'ghcr.io/web-arena-x/postmill-populated-exposed-withimg',
    port: 9999,
    containerPort: 80,
    envKey: 'WA_REDDIT',
  },
  {
    name: 'wa-gitlab',
    image: 'ghcr.io/web-arena-x/gitlab-populated-final-port8023',
    port: 8023,
    containerPort: 8023,
    envKey: 'WA_GITLAB',
  },
  {
    name: 'wa-wikipedia',
    image: 'ghcr.io/web-arena-x/wikipedia',
    port: 8888,
    containerPort: 80,
    envKey: 'WA_WIKIPEDIA',
  },
  {
    name: 'wa-homepage',
    image: 'ghcr.io/web-arena-x/homepage',
    port: 4399,
    containerPort: 4399,
    envKey: 'WA_HOMEPAGE',
  },
]

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe', ...opts }).trim()
  } catch (e) {
    if (opts.ignoreError) return ''
    throw e
  }
}

function status() {
  console.log('WebArena container status:')
  for (const svc of SERVICES) {
    const running = exec(`docker ps --filter name=${svc.name} --format "{{.Status}}"`, { ignoreError: true })
    const exists = exec(`docker ps -a --filter name=${svc.name} --format "{{.Status}}"`, { ignoreError: true })
    const icon = running ? '✓' : exists ? '○' : '✗'
    console.log(`  ${icon} ${svc.name.padEnd(20)} :${svc.port}  ${running || exists || 'not created'}`)
  }
}

function stop() {
  console.log('Stopping WebArena containers...')
  for (const svc of SERVICES) {
    exec(`docker stop ${svc.name}`, { ignoreError: true })
    exec(`docker rm ${svc.name}`, { ignoreError: true })
  }
  console.log('Stopped.')
}

function start() {
  console.log('Starting WebArena containers...')
  for (const svc of SERVICES) {
    const exists = exec(`docker ps -a --filter name=${svc.name} --format "{{.Names}}"`, { ignoreError: true })
    if (exists) {
      console.log(`  Starting existing ${svc.name}...`)
      exec(`docker start ${svc.name}`)
    } else {
      console.log(`  Creating ${svc.name} (${svc.image})...`)
      exec(`docker run -d --name ${svc.name} -p ${svc.port}:${svc.containerPort} ${svc.image}`)
    }
  }
  console.log('\nWaiting for services to initialize (GitLab takes ~60s)...')

  // Write env file
  const envLines = SERVICES.map((svc) => `${svc.envKey}=http://${HOST}:${svc.port}`)
  envLines.push(`WA_SHOPPING_ADMIN=http://${HOST}:7780/admin`)
  const envPath = path.join(path.dirname(new URL(import.meta.url).pathname), '.env')
  fs.writeFileSync(envPath, envLines.join('\n') + '\n')
  console.log(`\nEnvironment written to ${envPath}`)
  console.log('Source it before running: export $(cat bench/external/webarena/.env | xargs)')
}

function pull() {
  console.log('Pulling WebArena Docker images (this may take a while)...')
  for (const svc of SERVICES) {
    console.log(`  Pulling ${svc.image}...`)
    try {
      execSync(`docker pull ${svc.image}`, { stdio: 'inherit' })
    } catch {
      console.error(`  WARNING: Failed to pull ${svc.image} — may need authentication or the image may not exist`)
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

if (hasFlag('status')) {
  status()
} else if (hasFlag('stop')) {
  stop()
} else if (hasFlag('reset')) {
  stop()
  start()
} else if (hasFlag('start')) {
  start()
} else {
  pull()
  start()
  status()
}
