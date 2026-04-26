/**
 * Anchor loader — Layer 1 of the world-class design-audit architecture.
 *
 * Loads per-page-type calibration anchors from `anchors/<type>.yaml`. Each
 * anchor encodes score-band criteria + reference fixtures so the LLM scores
 * an saas-app like Linear's app, not like Linear's marketing site.
 *
 * Schema:
 *   type: <PageType>
 *   score_9_10: { criteria: string[], fixtures: string[] }
 *   score_7_8:  { criteria: string[], fixtures: string[] }
 *   score_5_6:  { criteria: string[], fixtures: string[] }
 *   score_3_4:  { criteria: string[], fixtures: string[] }
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageType } from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ANCHORS_DIR = path.join(__dirname, 'anchors')

export interface AnchorBand {
  criteria: string[]
  fixtures: string[]
}

export interface CalibrationAnchor {
  type: PageType
  score_9_10: AnchorBand
  score_7_8: AnchorBand
  score_5_6: AnchorBand
  score_3_4: AnchorBand
}

const REQUIRED_BANDS = ['score_9_10', 'score_7_8', 'score_5_6', 'score_3_4'] as const

/**
 * Parse one anchor YAML. Uses a minimal YAML reader that handles the shape:
 *   type: saas-app
 *   score_9_10:
 *     criteria:
 *       - line one
 *       - line two
 *     fixtures:
 *       - fixture:linear-app
 *
 * Avoids pulling in a YAML dep for ~9 small files. Throws on malformed input.
 */
export function parseAnchorFile(filePath: string): CalibrationAnchor {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const parsed = parseAnchorYaml(raw)

  if (!parsed.type || typeof parsed.type !== 'string') {
    throw new Error(`anchor ${filePath} missing 'type' field`)
  }

  for (const band of REQUIRED_BANDS) {
    const node = parsed[band]
    if (!node || typeof node !== 'object') {
      throw new Error(`anchor ${filePath} missing '${band}' band`)
    }
    const b = node as { criteria?: unknown; fixtures?: unknown }
    if (!Array.isArray(b.criteria) || b.criteria.length === 0) {
      throw new Error(`anchor ${filePath} '${band}.criteria' must be a non-empty array`)
    }
    if (!Array.isArray(b.fixtures) || b.fixtures.length === 0) {
      throw new Error(`anchor ${filePath} '${band}.fixtures' must be a non-empty array`)
    }
  }

  return parsed as unknown as CalibrationAnchor
}

/** Load all anchors from `anchors/` into a map keyed by PageType. */
export function loadAnchors(dir: string = ANCHORS_DIR): Map<PageType, CalibrationAnchor> {
  const out = new Map<PageType, CalibrationAnchor>()
  if (!fs.existsSync(dir)) return out
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    const anchor = parseAnchorFile(path.join(dir, file))
    out.set(anchor.type, anchor)
  }
  return out
}

/** Render an anchor as a markdown block for prompt injection. */
export function renderAnchor(anchor: CalibrationAnchor): string {
  const band = (label: string, b: AnchorBand): string =>
    `${label}\n${b.criteria.map((c) => `- ${c}`).join('\n')}\nReferences: ${b.fixtures.join(', ')}`
  return [
    `Calibration anchor for ${anchor.type}:`,
    band('Score 9-10:', anchor.score_9_10),
    band('Score 7-8:', anchor.score_7_8),
    band('Score 5-6:', anchor.score_5_6),
    band('Score 3-4:', anchor.score_3_4),
  ].join('\n\n')
}

/**
 * Minimal YAML parser scoped to the anchor file shape. Supports:
 *   key: scalar
 *   key:
 *     subkey: scalar
 *     subkey:
 *       - list item
 *
 * Indentation is normalized to spaces; tabs are not supported.
 */
function parseAnchorYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const root: Record<string, unknown> = {}
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const indent = leadingSpaces(line)
    if (indent !== 0) {
      i++
      continue
    }
    const m = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const [, key, valueRaw] = m
    const value = valueRaw.trim()
    if (value === '') {
      const { node, nextIndex } = readBlock(lines, i + 1, 2)
      root[key] = node
      i = nextIndex
    } else {
      root[key] = parseScalar(value)
      i++
    }
  }

  return root
}

function readBlock(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): { node: Record<string, unknown> | string[]; nextIndex: number } {
  // Detect: is this a list ("- item") or a map?
  let i = startIndex
  while (i < lines.length && !lines[i].trim()) i++
  if (i >= lines.length) return { node: {}, nextIndex: i }

  const firstIndent = leadingSpaces(lines[i])
  if (firstIndent < baseIndent) return { node: {}, nextIndex: i }

  if (lines[i].trim().startsWith('- ') || lines[i].trim() === '-') {
    const items: string[] = []
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        i++
        continue
      }
      const indent = leadingSpaces(line)
      if (indent < baseIndent) break
      const trimmed = line.trim()
      if (!trimmed.startsWith('-')) break
      const item = trimmed.replace(/^-\s*/, '')
      items.push(parseScalar(item) as string)
      i++
    }
    return { node: items, nextIndex: i }
  }

  const map: Record<string, unknown> = {}
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const indent = leadingSpaces(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      i++
      continue
    }
    const m = line.match(/^\s*([a-zA-Z_][\w-]*):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const [, key, valueRaw] = m
    const value = valueRaw.trim()
    if (value === '') {
      const { node, nextIndex } = readBlock(lines, i + 1, baseIndent + 2)
      map[key] = node
      i = nextIndex
    } else {
      map[key] = parseScalar(value)
      i++
    }
  }
  return { node: map, nextIndex: i }
}

function leadingSpaces(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

function parseScalar(raw: string): unknown {
  let value = raw.trim()
  if (value === '') return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  return value
}
