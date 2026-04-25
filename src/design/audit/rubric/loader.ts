/**
 * Rubric loader — reads markdown fragments with YAML frontmatter, composes
 * a rubric from the set whose `applies-when` predicates match a classification.
 *
 * Adding a new rubric: drop a markdown file in `fragments/` (or in
 * `~/.bad/rubrics/` for user fragments). No code changes required.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  PageClassification,
  RubricFragment,
  ComposedRubric,
  AppliesWhen,
} from '../types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN_FRAGMENTS_DIR = path.join(__dirname, 'fragments')

const WEIGHT_ORDER: Record<RubricFragment['weight'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Parse a markdown fragment file into a RubricFragment.
 * Frontmatter format:
 *   ---
 *   id: foo
 *   title: Foo
 *   weight: high
 *   applies-when:
 *     type: [marketing]
 *     domain: [fintech]
 *   ---
 *   body markdown...
 */
export function parseFragment(filePath: string): RubricFragment {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    throw new Error(`fragment ${filePath} missing YAML frontmatter`)
  }
  const [, frontmatter, body] = match
  const meta = parseMinimalYaml(frontmatter)

  return {
    id: String(meta.id ?? path.basename(filePath, '.md')),
    title: String(meta.title ?? meta.id ?? 'Untitled'),
    weight: (meta.weight as RubricFragment['weight']) ?? 'medium',
    appliesWhen: (meta['applies-when'] as AppliesWhen) ?? {},
    body: body.trim(),
    ...(meta.dimension ? { dimension: String(meta.dimension) } : {}),
  }
}

/**
 * Minimal YAML parser — supports the subset our frontmatter uses:
 *   key: value
 *   key: [a, b, c]
 *   key:
 *     subkey: [a, b]
 *
 * Avoids pulling in a full YAML dep for ~50 lines of config.
 */
function parseMinimalYaml(text: string): Record<string, unknown> {
  const lines = text.split('\n')
  const result: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const topMatch = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/)
    if (!topMatch) {
      i++
      continue
    }
    const [, key, valueRaw] = topMatch
    const value = valueRaw.trim()
    if (value === '') {
      // Nested object — collect indented lines
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
      .map(s => s.trim())
      .filter(Boolean)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/**
 * Load all fragments from a directory. Recursive subdirs ignored — fragments are flat.
 */
export function loadFragments(dir: string = BUILTIN_FRAGMENTS_DIR): RubricFragment[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseFragment(path.join(dir, f)))
}

/**
 * Predicate evaluator. Returns true if the fragment applies to the classification.
 *
 * Universal fragments always apply.
 * Type/domain/maturity/designSystem predicates are AND-combined: all listed
 * fields must match. Within a field, the classification value must be in the
 * fragment's allowed set.
 */
export function fragmentApplies(
  fragment: RubricFragment,
  classification: PageClassification,
): boolean {
  const w = fragment.appliesWhen
  if (w.universal) return true

  if (w.type && w.type.length > 0) {
    if (!w.type.includes(classification.type)) return false
  }
  if (w.domain && w.domain.length > 0) {
    const domainMatch = w.domain.some(d =>
      classification.domain.toLowerCase().includes(d.toLowerCase()),
    )
    if (!domainMatch) return false
  }
  if (w.maturity && w.maturity.length > 0) {
    if (!w.maturity.includes(classification.maturity)) return false
  }
  if (w.designSystem && w.designSystem.length > 0) {
    if (!w.designSystem.includes(classification.designSystem)) return false
  }

  // If at least one predicate field was set and all matched, apply.
  // If NO predicates were set and not universal, don't apply (be conservative).
  const hasPredicate =
    !!w.type?.length ||
    !!w.domain?.length ||
    !!w.maturity?.length ||
    !!w.designSystem?.length
  return hasPredicate
}

/**
 * Compose a rubric from a classification.
 *
 * @param classification - the page classification
 * @param fragments - all loaded fragments (defaults to builtin)
 * @param userFragmentsDir - optional path to user-supplied fragments
 */
export function composeRubric(
  classification: PageClassification,
  fragments?: RubricFragment[],
  userFragmentsDir?: string,
): ComposedRubric {
  const all = [
    ...(fragments ?? loadFragments(BUILTIN_FRAGMENTS_DIR)),
    ...(userFragmentsDir ? loadFragments(userFragmentsDir) : []),
  ]

  const matched = all
    .filter(f => fragmentApplies(f, classification))
    .sort((a, b) => WEIGHT_ORDER[a.weight] - WEIGHT_ORDER[b.weight])

  const body = matched
    .map(f => `## ${f.title}\n\n${f.body}`)
    .join('\n\n---\n\n')

  // Calibration is the universal-calibration fragment if loaded; otherwise
  // a sensible default.
  const calFragment = matched.find(f => f.id === 'universal-calibration')
  const calibration =
    calFragment?.body ??
    'Score 1-10. Most production apps score 5-7. Only world-class deserves 8+. Be honest.'

  // Custom dimensions contributed by fragments (deduped, preserves order)
  const dimensions = Array.from(
    new Set(matched.map(f => f.dimension).filter((d): d is string => Boolean(d))),
  )

  return {
    fragments: matched,
    body,
    calibration,
    dimensions,
  }
}

/**
 * Compose a rubric from an explicit profile name (for `--profile` override).
 * Loads only the matching type fragment + universal fragments.
 */
export function composeRubricFromProfile(
  profile: string,
  fragmentsOverride?: RubricFragment[],
): ComposedRubric {
  const all = fragmentsOverride ?? loadFragments(BUILTIN_FRAGMENTS_DIR)
  const normalizedProfile = profile.toLowerCase()
  const profileFragmentIds = profileToFragmentIds(normalizedProfile)
  const wanted = new Set([
    ...profileFragmentIds,
    'universal-foundation',
    'universal-product-intent',
    'universal-calibration',
    'universal-effort-anchor',
  ])
  const matched = all
    .filter(f => wanted.has(f.id))
    .sort((a, b) => WEIGHT_ORDER[a.weight] - WEIGHT_ORDER[b.weight])

  const body = matched.map(f => `## ${f.title}\n\n${f.body}`).join('\n\n---\n\n')
  const calFragment = matched.find(f => f.id === 'universal-calibration')
  const calibration =
    calFragment?.body ??
    'Score 1-10. Most production apps score 5-7. Only world-class deserves 8+. Be honest.'

  const dimensions = Array.from(
    new Set(matched.map(f => f.dimension).filter((d): d is string => Boolean(d))),
  )

  return { fragments: matched, body, calibration, dimensions }
}

function profileToFragmentIds(profile: string): string[] {
  switch (profile) {
    case 'saas':
    case 'app':
    case 'dashboard':
      return ['type-saas-app']
    case 'defi':
    case 'crypto':
    case 'web3':
      return ['type-saas-app', 'domain-crypto']
    case 'devtools':
    case 'developer':
    case 'dev':
      return ['type-saas-app', 'domain-devtools']
    case 'ai':
    case 'ml':
    case 'llm':
      return ['type-saas-app', 'domain-ai']
    case 'fintech':
    case 'finance':
      return ['type-saas-app', 'domain-fintech']
    case 'general':
      return []
    default:
      return [`type-${profile}`]
  }
}
