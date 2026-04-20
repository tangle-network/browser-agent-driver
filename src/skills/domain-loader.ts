/**
 * Domain-skill loader — reads `skills/domain/<host>/SKILL.md` files from
 * the bad repo and exposes them as a `BadExtension`-compatible bundle so
 * the existing `setExtensionRules` path at brain/index.ts:899 picks up the
 * per-domain rules without a second injection site.
 *
 * Inspired by browser-use/browser-harness's `domain-skills/` layout.
 * The differences that matter:
 *
 *   1. Every skill carries YAML frontmatter with `host` + optional
 *      `aliases` so one file covers www.amazon.com + smile.amazon.com.
 *   2. The body is plain markdown — no code, no enforcement. It lands
 *      verbatim in the system prompt's USER RULES (domain match) section
 *      that already exists at brain/index.ts:865-870.
 *   3. Skills under `skills/domain/experimental/<host>/` are loaded into
 *      the same registry but tagged so the promotion script can demote
 *      those whose bench cases don't produce a measurable win.
 *
 * No YAML parser dep — we handle the tiny subset we support (flat
 * key/value + single-line array aliases) with regex. If a skill needs
 * more expressive metadata, grow the parser with a failing test first.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BadExtension, DomainRules } from '../extensions/types.js'

/** Parsed frontmatter + body split, before we turn it into rules. */
export interface ParsedDomainSkill {
  /** Primary hostname the skill applies to (e.g. "amazon.com") */
  host: string
  /** Extra hosts that share the same rules (e.g. ["smile.amazon.com"]) */
  aliases: string[]
  /** Optional human-readable label */
  title?: string
  /** Markdown body verbatim (no processing — goes straight into the prompt) */
  body: string
  /** Absolute path to the source file, for logging and promotion flows */
  sourcePath: string
  /** Whether this skill lives under experimental/ */
  experimental: boolean
}

/** Cap on the body size we'll inject, to keep domain rules from blowing up
 * the system prompt. Bodies longer than this are truncated with a marker
 * and the loader warns. 4 KB is ~1000 tokens — comfortable headroom even
 * across multiple domain matches. */
export const MAX_DOMAIN_BODY_BYTES = 4096

/**
 * Parse a single SKILL.md file. The caller has already read the raw text.
 * Throws on missing `host` — that's not a recoverable schema hole, we
 * want the loader to surface it.
 */
export function parseDomainSkill(raw: string, sourcePath: string, experimental = false): ParsedDomainSkill {
  const { frontmatter, body } = splitFrontmatter(raw)
  const meta = parseFrontmatterBlock(frontmatter)
  const host = typeof meta.host === 'string' ? meta.host.trim() : ''
  if (!host) {
    throw new Error(`${sourcePath}: frontmatter missing required "host" field`)
  }
  const aliases = Array.isArray(meta.aliases)
    ? meta.aliases.map(String).map((s) => s.trim()).filter(Boolean)
    : []
  const title = typeof meta.title === 'string' ? meta.title.trim() : undefined

  let trimmedBody = body.trim()
  if (Buffer.byteLength(trimmedBody, 'utf-8') > MAX_DOMAIN_BODY_BYTES) {
    trimmedBody = trimmedBody.slice(0, MAX_DOMAIN_BODY_BYTES).trimEnd() +
      '\n\n[…truncated — domain skill body exceeded MAX_DOMAIN_BODY_BYTES]'
  }
  return {
    host,
    aliases,
    title,
    body: trimmedBody,
    sourcePath,
    experimental,
  }
}

/** Split `---\nfrontmatter\n---\nbody` into its two parts. Files without
 * frontmatter (missing opening `---\n`) are treated as body-only. The
 * strict `---\n` match avoids misinterpreting a body that happens to
 * start with a markdown horizontal rule. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { frontmatter: '', body: raw }
  const afterOpenDelimiter = raw.startsWith('---\r\n') ? 5 : 4
  // Closing delimiter must be on its own line (\n---\n or \n---\r\n or EOF).
  const bodyStart = raw.indexOf('\n---\n', afterOpenDelimiter)
  const altStart = raw.indexOf('\n---\r\n', afterOpenDelimiter)
  const endIndex = altStart !== -1 && (bodyStart === -1 || altStart < bodyStart) ? altStart : bodyStart
  if (endIndex === -1) return { frontmatter: '', body: raw }
  const frontmatter = raw.slice(afterOpenDelimiter, endIndex).trim()
  const bodyOffset = raw.indexOf('\n', endIndex + 4) // skip past the closing --- and its newline
  const body = bodyOffset >= 0 ? raw.slice(bodyOffset + 1) : ''
  return { frontmatter, body }
}

/** Tiny YAML subset: flat scalars + single-line [a, b] arrays. Quoted and
 * unquoted strings both work; inline comments (`# …`) are ignored. */
function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!block) return out
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let rawVal = match[2].replace(/\s+#.*$/, '').trim()
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      out[key] = rawVal.slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
    } else if ((rawVal.startsWith('"') && rawVal.endsWith('"')) || (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
      out[key] = rawVal.slice(1, -1)
    } else {
      out[key] = rawVal
    }
  }
  return out
}

export interface LoadDomainSkillsOptions {
  /** Root directory containing the domain skill tree. Defaults to the
   * `skills/domain` dir shipped with the bad package. */
  rootDir?: string
  /** Logger for load errors. Defaults to a stderr warning. */
  onError?: (sourcePath: string, err: unknown) => void
}

export interface LoadDomainSkillsResult {
  skills: ParsedDomainSkill[]
  /** Files that failed to parse. Never throws — a broken file should never
   * bring down the run, but the operator needs to see which file it was. */
  errors: Array<{ path: string; error: string }>
}

/** Locate the packaged `skills/domain` directory. Works both when running
 * from source (tsx/test) and from the built dist/ layout. */
export function defaultDomainSkillsRoot(): string {
  const here = fileURLToPath(import.meta.url)
  // src layout:  src/skills/domain-loader.ts     → <repo>/skills/domain
  // dist layout: dist/skills/domain-loader.js    → <repo>/skills/domain
  const packageRoot = path.resolve(path.dirname(here), '..', '..')
  return path.join(packageRoot, 'skills', 'domain')
}

/** Walk the domain tree and return parsed skills. Missing dir ⇒ empty list,
 * not an error: shipping without any seeded skills is a valid state. */
export async function loadDomainSkills(options: LoadDomainSkillsOptions = {}): Promise<LoadDomainSkillsResult> {
  const rootDir = options.rootDir ?? defaultDomainSkillsRoot()
  const onError = options.onError ?? ((p, err) => {
    // eslint-disable-next-line no-console
    console.error(`[domain-skill] failed to load ${p}: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!fs.existsSync(rootDir)) return { skills: [], errors: [] }

  const skills: ParsedDomainSkill[] = []
  const errors: Array<{ path: string; error: string }> = []

  for (const candidate of walkSkillMarkdown(rootDir)) {
    try {
      const raw = fs.readFileSync(candidate.path, 'utf-8')
      const parsed = parseDomainSkill(raw, candidate.path, candidate.experimental)
      skills.push(parsed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ path: candidate.path, error: message })
      onError(candidate.path, err)
    }
  }
  return { skills, errors }
}

/** Enumerate <root>/<host>/SKILL.md and <root>/experimental/<host>/SKILL.md.
 * Any other files or directory depths are ignored — the layout is strict on
 * purpose so we don't accidentally pick up READMEs or notes. */
function* walkSkillMarkdown(rootDir: string): Generator<{ path: string; experimental: boolean }> {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const entryPath = path.join(rootDir, entry.name)
    if (entry.name === 'experimental') {
      for (const inner of fs.readdirSync(entryPath, { withFileTypes: true })) {
        if (!inner.isDirectory()) continue
        const skillPath = path.join(entryPath, inner.name, 'SKILL.md')
        if (fs.existsSync(skillPath)) yield { path: skillPath, experimental: true }
      }
      continue
    }
    const skillPath = path.join(entryPath, 'SKILL.md')
    if (fs.existsSync(skillPath)) yield { path: skillPath, experimental: false }
  }
}

/** Collapse a list of parsed skills into a BadExtension so they flow through
 * the existing resolveExtensions → setExtensionRules path. Aliases are only
 * emitted as additional keys when they can't already be reached by the
 * matcher's substring comparison — otherwise the same body would be
 * concatenated onto itself at match time. */
export function buildDomainSkillExtension(skills: ParsedDomainSkill[]): BadExtension {
  const addRulesForDomain: Record<string, DomainRules> = {}
  for (const skill of skills) {
    const body = skill.body
    addBody(addRulesForDomain, skill.host, body)
    for (const alias of skill.aliases) {
      // Skip aliases that already match via substring on the primary or any
      // prior alias — registering them would double-emit the body when the
      // brain matcher walks every registered key.
      if (alias.includes(skill.host)) continue
      if (skill.aliases.some((other) => other !== alias && alias.includes(other))) continue
      addBody(addRulesForDomain, alias, body)
    }
  }
  return { addRulesForDomain }
}

function addBody(map: Record<string, DomainRules>, host: string, body: string): void {
  const existing = map[host]
  if (existing && existing.extraRules) {
    existing.extraRules = `${existing.extraRules}\n\n${body}`
  } else {
    map[host] = { extraRules: body }
  }
}
