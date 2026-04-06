#!/usr/bin/env node
/**
 * Copy markdown rubric fragments from src/ to dist/ after tsc compile.
 * tsc doesn't move non-TS files; this script keeps the runtime layout
 * matching src/ so `loader.ts` can resolve fragments via __dirname.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src/design/audit/rubric/fragments')
const distDir = path.join(root, 'dist/design/audit/rubric/fragments')

if (!fs.existsSync(srcDir)) {
  console.error(`source fragments dir not found: ${srcDir}`)
  process.exit(1)
}

fs.mkdirSync(distDir, { recursive: true })

let copied = 0
for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.md')) continue
  fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file))
  copied++
}

console.log(`copied ${copied} rubric fragment(s) to dist/`)
