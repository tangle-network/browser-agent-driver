#!/usr/bin/env node
/**
 * Tag the current version and push the prefixed alias the existing
 * release.yml + publish-npm.yml workflows expect.
 *
 * Why two tags:
 *   - Changesets default `changeset tag` writes a `vX.Y.Z` style tag.
 *     We let it do that for compatibility with anyone reading the
 *     unprefixed convention (npm, GitHub release auto-discovery, etc).
 *   - The repo's existing publish workflows trigger on
 *     `browser-agent-driver-vX.Y.Z` (prefixed). We push that too so
 *     the tag-driven publish chain fires automatically.
 *
 * Idempotent: safe to re-run, won't double-tag if the prefixed tag
 * already exists.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
  }
}

function shCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' })
  return { stdout: r.stdout?.trim() ?? '', status: r.status }
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
const version = pkg.version
const prefixedTag = `browser-agent-driver-v${version}`

console.log(`release-tag: package version is ${version}`)

// 1. Run changeset's standard tag command (creates the unprefixed v* tag)
sh('pnpm', ['exec', 'changeset', 'tag'])

// 2. Add the prefixed tag pointing at the same commit, unless it
//    already exists. Use HEAD so we tag the version-packages merge commit.
const existing = shCapture('git', ['tag', '-l', prefixedTag])
if (existing.stdout === prefixedTag) {
  console.log(`release-tag: ${prefixedTag} already exists, skipping create`)
} else {
  sh('git', ['tag', prefixedTag, 'HEAD'])
  console.log(`release-tag: created ${prefixedTag}`)
}

// 3. Push everything (commits + all new tags)
sh('git', ['push', '--follow-tags'])
sh('git', ['push', 'origin', prefixedTag])

console.log(`release-tag: pushed ${prefixedTag} — publish workflows should fire now`)
