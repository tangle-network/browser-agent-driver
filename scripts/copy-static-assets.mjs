#!/usr/bin/env node
/**
 * Copy non-TS assets from src/ to dist/ after tsc compile.
 * tsc only emits .js/.d.ts/.js.map; this script keeps the runtime layout
 * matching src/ for everything else.
 *
 * Currently copies:
 *   - src/design/audit/rubric/fragments/*.md (rubric library)
 *   - src/design/audit/rubric/anchors/*.yaml (calibration anchors)
 *   - src/design/audit/ethics/rules/*.yaml (ethics gate rules)
 *   - src/viewer/*.html (session viewer UI)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const COPIES = [
  {
    label: 'rubric fragment(s)',
    src: 'src/design/audit/rubric/fragments',
    dest: 'dist/design/audit/rubric/fragments',
    pattern: /\.md$/,
  },
  {
    label: 'rubric anchor(s)',
    src: 'src/design/audit/rubric/anchors',
    dest: 'dist/design/audit/rubric/anchors',
    pattern: /\.ya?ml$/,
  },
  {
    label: 'ethics rule(s)',
    src: 'src/design/audit/ethics/rules',
    dest: 'dist/design/audit/ethics/rules',
    pattern: /\.ya?ml$/,
  },
  {
    label: 'viewer asset(s)',
    src: 'src/viewer',
    dest: 'dist/viewer',
    pattern: /\.(html|css|js|svg|png|jpe?g)$/,
  },
]

let totalCopied = 0
for (const c of COPIES) {
  const srcDir = path.join(root, c.src)
  const destDir = path.join(root, c.dest)

  if (!fs.existsSync(srcDir)) {
    console.warn(`skip ${c.label}: source dir missing (${srcDir})`)
    continue
  }
  fs.mkdirSync(destDir, { recursive: true })

  let copied = 0
  for (const file of fs.readdirSync(srcDir)) {
    if (!c.pattern.test(file)) continue
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file))
    copied++
  }
  console.log(`copied ${copied} ${c.label} to dist/`)
  totalCopied += copied
}

if (totalCopied === 0) {
  console.warn('warning: no static assets copied')
}
