/**
 * Ethics rule loader — Layer 7.
 *
 * Loads `EthicsRule[]` from `rules/*.yaml`. Idempotent + cached: the in-memory
 * cache keys on directory path so repeated calls (per-page audits) never re-IO.
 *
 * Each YAML file is a list of rule objects. The minimal parser supports the
 * shape used in the RFC: `- key: value` items with nested objects and inline
 * `[a, b]` lists. No external yaml dep — same approach as rubric/loader.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  EthicsRule,
  EthicsCategory,
  EthicsSeverity,
  EthicsDetector,
  AppliesWhen,
} from '../score-types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN_RULES_DIR = path.join(__dirname, 'rules')

const cache = new Map<string, EthicsRule[]>()

/** Severity → rollup ceiling. critical-floor caps at 4; major-floor caps at 6. */
export function rollupCapFor(severity: EthicsSeverity): number {
  return severity === 'critical-floor' ? 4 : 6
}

/**
 * Load every `*.yaml` rule file in `dir`. Cached by absolute path.
 * Returns a stable order (sorted by filename + position within file).
 */
export function loadEthicsRules(dir: string = BUILTIN_RULES_DIR): EthicsRule[] {
  const abs = path.resolve(dir)
  const cached = cache.get(abs)
  if (cached) return cached
  if (!fs.existsSync(abs)) {
    cache.set(abs, [])
    return []
  }
  const rules: EthicsRule[] = []
  const files = fs.readdirSync(abs).filter(f => f.endsWith('.yaml')).sort()
  for (const f of files) {
    const file = path.join(abs, f)
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = parseRuleList(raw, file)
    for (const r of parsed) rules.push(r)
  }
  cache.set(abs, rules)
  return rules
}

/** Reset cache — test-only. */
export function clearEthicsRuleCache(): void {
  cache.clear()
}

function parseRuleList(text: string, sourceFile: string): EthicsRule[] {
  const items = splitTopLevelItems(text)
  return items.map((block, idx) => parseRule(block, `${sourceFile}#${idx}`))
}

/** Split a YAML doc into top-level `- item` blocks (one block per rule). */
function splitTopLevelItems(text: string): string[] {
  const lines = text.split('\n')
  const items: string[] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') {
      if (current) current.push(line)
      continue
    }
    if (line.startsWith('- ')) {
      if (current) items.push(current.join('\n'))
      current = [line.slice(2)]
    } else if (current) {
      // Indented continuation. Strip 2 leading spaces if present so nesting
      // levels become consistent within the item.
      current.push(line.startsWith('  ') ? line.slice(2) : line)
    }
  }
  if (current) items.push(current.join('\n'))
  return items
}

function parseRule(block: string, ref: string): EthicsRule {
  const meta = parseYamlBlock(block)
  const ruleId = stringField(meta, 'ruleId', ref)
  const category = stringField(meta, 'category', ref) as EthicsCategory
  const severity = stringField(meta, 'severity', ref) as EthicsSeverity
  if (severity !== 'critical-floor' && severity !== 'major-floor') {
    throw new Error(`ethics rule ${ruleId} (${ref}): invalid severity ${severity}`)
  }
  const remediation = stringField(meta, 'remediation', ref)
  const appliesWhen = (meta.appliesWhen as AppliesWhen) ?? {}
  const detectorRaw = (meta.detector as Record<string, unknown>) ?? {}
  const detector = parseDetector(detectorRaw, ruleId)
  const citation = meta.citation != null ? String(meta.citation) : undefined
  return {
    ruleId,
    category,
    severity,
    appliesWhen,
    detector,
    remediation,
    ...(citation ? { citation } : {}),
  }
}

function parseDetector(d: Record<string, unknown>, ruleId: string): EthicsDetector {
  const kind = String(d.kind ?? '')
  if (kind === 'pattern-absent' || kind === 'pattern-present') {
    const pattern = String(d.pattern ?? '')
    if (!pattern) throw new Error(`ethics rule ${ruleId}: detector.pattern required for ${kind}`)
    return { kind, pattern }
  }
  if (kind === 'llm-classifier') {
    const llmCheck = String(d.llmCheck ?? '')
    if (!llmCheck) throw new Error(`ethics rule ${ruleId}: detector.llmCheck required for llm-classifier`)
    return { kind, llmCheck }
  }
  throw new Error(`ethics rule ${ruleId}: unknown detector.kind ${kind}`)
}

function stringField(meta: Record<string, unknown>, key: string, ref: string): string {
  const v = meta[key]
  if (v == null || String(v) === '') {
    throw new Error(`ethics rule (${ref}): missing required field ${key}`)
  }
  return String(v)
}

/**
 * YAML block parser supporting:
 *   key: scalar
 *   key: [a, b]
 *   key: |  → folded multi-line block (preserves newlines)
 *   key: > or just continuation lines indented under the key
 *   key:
 *     subkey: value
 *     listKey: [a, b]
 */
function parseYamlBlock(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  const result: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const m = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
    if (!m) {
      i++
      continue
    }
    const [, key, valueRaw] = m
    const value = valueRaw.trim()
    if (value === '|' || value === '>') {
      // Folded block: collect indented continuation lines.
      const collected: string[] = []
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        collected.push(lines[i].replace(/^ {2}/, ''))
        i++
      }
      result[key] = collected.join(value === '|' ? '\n' : ' ').trim()
    } else if (value === '') {
      // Nested object — collect indented lines.
      const nested: Record<string, unknown> = {}
      i++
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        if (!lines[i].trim()) {
          i++
          continue
        }
        const nm = lines[i].match(/^\s+([a-zA-Z][\w-]*):\s*(.*)$/)
        if (nm) {
          nested[nm[1]] = parseScalarOrList(nm[2].trim())
        }
        i++
      }
      result[key] = nested
    } else {
      result[key] = parseScalarOrList(value)
      i++
    }
  }
  return result
}

function parseScalarOrList(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
  }
  // Strip surrounding quotes for plain scalars.
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}
