#!/usr/bin/env node

/**
 * Convert WebVoyager JSONL tasks → browser-agent-driver case format.
 *
 * Usage:
 *   # Download data first:
 *   curl -L https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl \
 *     -o bench/external/webvoyager/tasks.jsonl
 *   curl -L https://raw.githubusercontent.com/magnitudedev/webvoyager/main/data/patches.json \
 *     -o bench/external/webvoyager/patches.json
 *
 *   # Convert:
 *   node bench/external/webvoyager/convert-tasks.mjs
 *   node bench/external/webvoyager/convert-tasks.mjs --site Google_Flights --max-tasks 10
 *   node bench/external/webvoyager/convert-tasks.mjs --exclude-removed --apply-patches
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
const hasFlag = (name) => argv.includes(`--${name}`)

const tasksPath = path.resolve(__dir, getArg('tasks', 'tasks.jsonl'))
const patchesPath = path.resolve(__dir, getArg('patches', 'patches.json'))
const applyPatches = hasFlag('apply-patches') || fs.existsSync(patchesPath)
const excludeRemoved = hasFlag('exclude-removed') || applyPatches
const filterSite = getArg('site')
const maxTasks = Number(getArg('max-tasks', '0'))
const maxTurns = Number(getArg('max-turns', '15'))
const timeoutMs = Number(getArg('timeout', '120000'))
const outFile = getArg('out', path.resolve(__dir, 'cases.json'))

// Load patches
let patches = {}
if (applyPatches && fs.existsSync(patchesPath)) {
  patches = JSON.parse(fs.readFileSync(patchesPath, 'utf8'))
  console.log(`Loaded ${Object.keys(patches).length} patches`)
}

// Load JSONL tasks
if (!fs.existsSync(tasksPath)) {
  console.error(`Tasks file not found: ${tasksPath}`)
  console.error('Download with:')
  console.error('  curl -L https://raw.githubusercontent.com/MinorJerry/WebVoyager/main/data/WebVoyager_data.jsonl \\')
  console.error(`    -o ${tasksPath}`)
  process.exit(1)
}

const lines = fs.readFileSync(tasksPath, 'utf8').trim().split('\n')
let tasks = lines.map((line) => JSON.parse(line))
console.log(`Loaded ${tasks.length} WebVoyager tasks`)

// Apply patches
let removed = 0
let patched = 0
if (applyPatches) {
  tasks = tasks.filter((t) => {
    const patch = patches[t.id]
    if (!patch) return true
    if (patch.remove) {
      removed++
      return !excludeRemoved
    }
    return true
  })
  tasks = tasks.map((t) => {
    const patch = patches[t.id]
    if (patch && !patch.remove && patch.new) {
      patched++
      return { ...t, ques: patch.new }
    }
    return t
  })
  console.log(`Applied patches: ${patched} modified, ${removed} removed → ${tasks.length} remaining`)
}

// Filter by site
if (filterSite) {
  tasks = tasks.filter((t) => t.web_name === filterSite || t.web_name.toLowerCase() === filterSite.toLowerCase())
  console.log(`Filtered to site "${filterSite}": ${tasks.length} tasks`)
}

// Limit
if (maxTasks > 0 && tasks.length > maxTasks) {
  tasks = tasks.slice(0, maxTasks)
  console.log(`Limited to ${maxTasks} tasks`)
}

// Convert to our case format
const cases = tasks.map((t) => ({
  id: `wv-${t.id}`,
  name: `WebVoyager ${t.web_name} #${t.id.split('--')[1]}`,
  startUrl: t.web,
  goal: t.ques,
  maxTurns,
  timeoutMs,
  tags: ['webvoyager', t.web_name.toLowerCase(), 'external-benchmark'],
  // Store original WebVoyager metadata for evaluation
  _wv: {
    originalId: t.id,
    webName: t.web_name,
  },
}))

fs.writeFileSync(outFile, JSON.stringify(cases, null, 2) + '\n')
console.log(`Wrote ${cases.length} cases to ${outFile}`)

// Write site breakdown
const bySite = {}
for (const c of cases) {
  const site = c._wv.webName
  bySite[site] = (bySite[site] || 0) + 1
}
console.log('\nBy site:')
for (const [site, count] of Object.entries(bySite).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${site}: ${count}`)
}
