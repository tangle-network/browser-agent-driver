#!/usr/bin/env node

/**
 * Convert WebArena task configs → browser-agent-driver case format.
 *
 * Reads WebArena's test.raw.json and generates cases pointing at the
 * self-hosted Docker services.
 *
 * Usage:
 *   # Download task configs first:
 *   curl -L https://raw.githubusercontent.com/web-arena-x/webarena/main/config_files/test.raw.json \
 *     -o bench/external/webarena/test.raw.json
 *
 *   # Convert (reads WA_* env vars for service URLs):
 *   node bench/external/webarena/convert-tasks.mjs
 *   node bench/external/webarena/convert-tasks.mjs --max-tasks 50 --site shopping
 */

import fs from 'node:fs'
import path from 'node:path'

const __dir = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)

const getArg = (name, fallback) => {
  const idx = argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  return argv[idx + 1]
}

const maxTasks = Number(getArg('max-tasks', '0'))
const filterSite = getArg('site', '')
const maxTurns = Number(getArg('max-turns', '20'))
const timeoutMs = Number(getArg('timeout', '180000'))
const tasksFile = path.resolve(__dir, getArg('tasks', 'test.raw.json'))
const outFile = getArg('out', path.resolve(__dir, 'cases.json'))

// Load env file if it exists
const envPath = path.join(__dir, '.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').trim().split('\n')) {
    const [key, ...val] = line.split('=')
    if (key && !process.env[key]) process.env[key] = val.join('=')
  }
}

// Service URL resolution
const SERVICE_URLS = {
  shopping: process.env.WA_SHOPPING || 'http://localhost:7770',
  shopping_admin: process.env.WA_SHOPPING_ADMIN || 'http://localhost:7780/admin',
  reddit: process.env.WA_REDDIT || 'http://localhost:9999',
  gitlab: process.env.WA_GITLAB || 'http://localhost:8023',
  wikipedia: process.env.WA_WIKIPEDIA || 'http://localhost:8888',
  map: process.env.WA_MAP || 'http://localhost:3000',
  homepage: process.env.WA_HOMEPAGE || 'http://localhost:4399',
}

if (!fs.existsSync(tasksFile)) {
  console.error(`Tasks file not found: ${tasksFile}`)
  console.error('Download with:')
  console.error('  curl -L https://raw.githubusercontent.com/web-arena-x/webarena/main/config_files/test.raw.json \\')
  console.error(`    -o ${tasksFile}`)
  process.exit(1)
}

let tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
console.log(`Loaded ${tasks.length} WebArena tasks`)

// Resolve __PLACEHOLDER__ URLs in start_url
function resolveUrl(url) {
  return url
    .replace(/__SHOPPING_ADMIN__/g, SERVICE_URLS.shopping_admin)
    .replace(/__SHOPPING__/g, SERVICE_URLS.shopping)
    .replace(/__REDDIT__/g, SERVICE_URLS.reddit)
    .replace(/__GITLAB__/g, SERVICE_URLS.gitlab)
    .replace(/__WIKIPEDIA__/g, SERVICE_URLS.wikipedia)
    .replace(/__MAP__/g, SERVICE_URLS.map)
    .replace(/__HOMEPAGE__/g, SERVICE_URLS.homepage)
}

// Detect primary site from task
function detectSite(task) {
  const sites = task.sites || []
  if (sites.includes('shopping_admin')) return 'shopping_admin'
  if (sites.includes('shopping')) return 'shopping'
  if (sites.includes('reddit')) return 'reddit'
  if (sites.includes('gitlab')) return 'gitlab'
  if (sites.includes('wikipedia')) return 'wikipedia'
  if (sites.includes('map')) return 'map'
  return sites[0] || 'unknown'
}

// Filter by site
if (filterSite) {
  tasks = tasks.filter((t) => {
    const site = detectSite(t)
    return site.toLowerCase().includes(filterSite.toLowerCase())
  })
  console.log(`Filtered to site "${filterSite}": ${tasks.length} tasks`)
}

// Limit
if (maxTasks > 0 && tasks.length > maxTasks) {
  tasks = tasks.slice(0, maxTasks)
  console.log(`Limited to ${maxTasks} tasks`)
}

// Convert
const cases = tasks.map((t) => {
  const site = detectSite(t)
  const startUrl = resolveUrl(t.start_url)

  return {
    id: `wa-${t.task_id}`,
    name: `WebArena #${t.task_id} (${site})`,
    startUrl,
    goal: t.intent,
    maxTurns,
    timeoutMs,
    tags: ['webarena', site, 'external-benchmark'],
    _wa: {
      taskId: t.task_id,
      sites: t.sites,
      requireLogin: t.require_login,
      requireReset: t.require_reset,
      eval: t.eval,
      storageState: t.storage_state,
    },
  }
})

fs.writeFileSync(outFile, JSON.stringify(cases, null, 2) + '\n')
console.log(`Wrote ${cases.length} cases to ${outFile}`)

// Site breakdown
const bySite = {}
for (const c of cases) {
  const site = detectSite({ sites: c._wa.sites })
  bySite[site] = (bySite[site] || 0) + 1
}
console.log('\nBy site:')
for (const [site, count] of Object.entries(bySite).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${site}: ${count}`)
}

// Eval type breakdown
const byEval = {}
for (const c of cases) {
  for (const et of c._wa.eval?.eval_types || []) {
    byEval[et] = (byEval[et] || 0) + 1
  }
}
console.log('\nBy eval type:')
for (const [et, count] of Object.entries(byEval).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${et}: ${count}`)
}
