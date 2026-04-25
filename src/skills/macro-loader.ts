/**
 * Macro loader and executor. Reads `skills/macros/*.json` files and validates
 * each into a typed MacroDefinition. A macro is a flat ordered list of
 * existing primitive Actions with string-template interpolation over its
 * declared params.
 *
 * This is the minimum viable mutable tool surface: the agent can add new
 * capability by composing safe primitives into named workflows, without us
 * eval-ing arbitrary code. Raw TS/JS handlers are a later generation's fight.
 *
 * Safety invariants (all enforced at load time, tested):
 *   1. Step types are restricted to SAFE_MACRO_STEP_TYPES. No `macro` steps
 *      (flat only). No `navigate` — macros are page-interaction primitives,
 *      not navigation helpers (macros get triggered when the agent is
 *      already somewhere).
 *   2. Param substitution only applies to string fields. Objects and numbers
 *      pass through as-is.
 *   3. Unknown params in steps (e.g. `${oops}`) are a load-time error.
 *   4. Duplicate macro names error at registration.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action } from '../types.js'

/**
 * A step inside a macro is any safe primitive action. We use Action
 * directly — the loader validates that `step.action` is in SAFE_MACRO_STEP_TYPES
 * at load time. Strings in these actions can carry `${param}` placeholders
 * that are substituted from the caller's args.
 */
export type MacroStep = Action

/** Primitive actions that are safe inside a macro. Explicitly whitelists —
 * any new Action type needs to be added here deliberately. Note that
 * `navigate` and `complete`/`abort` are intentionally absent: macros
 * compose local interactions, not run-level control flow. */
/** Maximum steps in a single macro. Bounds the total wall-time any one
 * macro can consume (step count × per-action timeout) to keep the
 * CLI's budget cap meaningful. Raising this requires a measured reason —
 * a longer macro is usually a hint that the work should split into two.
 */
const MAX_MACRO_STEPS = 8

export const SAFE_MACRO_STEP_TYPES = new Set<Action['action']>([
  'click',
  'type',
  'press',
  'hover',
  'select',
  'scroll',
  'wait',
  'clickAt',
  'typeAt',
  'clickLabel',
  'typeLabel',
  'clickSequence',
  'fill',
])

export interface MacroParamSpec {
  name: string
  description?: string
  /** Minimum required; if absent the macro can be invoked without this arg */
  required?: boolean
}

export interface MacroDefinition {
  name: string
  description: string
  /** Declared parameters. Empty array if the macro takes no args. */
  params: MacroParamSpec[]
  /** Ordered, flat list of primitive actions */
  steps: MacroStep[]
  /** Where on disk this came from (for diagnostics) */
  sourcePath: string
  /** If true, macro is in staging and is NOT exposed in the agent's prompt
   *  until it passes eval-gated promotion. */
  experimental?: boolean
}

export interface MacroRegistry {
  macros: Map<string, MacroDefinition>
  /** The same list rendered for the LLM's system prompt */
  promptBlock: string
}

/** Exported for tests + promotion script to share the same root resolution.
 * BAD_MACROS_DIR overrides the packaged path — the promotion script uses this
 * to point at a staging directory without mutating the canonical tree. */
export function defaultMacrosRoot(): string {
  const override = process.env.BAD_MACROS_DIR
  if (override && override.length > 0) return path.resolve(override)
  const here = fileURLToPath(import.meta.url)
  // src/skills/macro-loader.ts → <repo>/skills/macros
  // dist/skills/macro-loader.js → <repo>/skills/macros
  const pkgRoot = path.resolve(path.dirname(here), '..', '..')
  return path.join(pkgRoot, 'skills', 'macros')
}

export interface LoadMacrosOptions {
  rootDir?: string
  /** Include experimental/ subdir (for the promotion script only). */
  includeExperimental?: boolean
  onError?: (p: string, err: unknown) => void
}

export interface LoadMacrosResult {
  macros: MacroDefinition[]
  errors: Array<{ path: string; error: string }>
}

export async function loadMacros(options: LoadMacrosOptions = {}): Promise<LoadMacrosResult> {
  const rootDir = options.rootDir ?? defaultMacrosRoot()
  const onError = options.onError ?? ((p, err) => {
    // eslint-disable-next-line no-console
    console.error(`[macro] failed to load ${p}: ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!fs.existsSync(rootDir)) return { macros: [], errors: [] }

  const candidates = collectMacroFiles(rootDir, options.includeExperimental ?? false)
  const macros: MacroDefinition[] = []
  const errors: Array<{ path: string; error: string }> = []
  const seen = new Set<string>()

  for (const { file, experimental } of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw) as unknown
      const macro = validateMacroDefinition(parsed, file, experimental)
      if (seen.has(macro.name)) {
        throw new Error(`Duplicate macro name "${macro.name}" (already loaded from a prior file)`)
      }
      seen.add(macro.name)
      macros.push(macro)
    } catch (err) {
      errors.push({ path: file, error: err instanceof Error ? err.message : String(err) })
      onError(file, err)
    }
  }
  return { macros, errors }
}

function collectMacroFiles(rootDir: string, includeExperimental: boolean): Array<{ file: string; experimental: boolean }> {
  const result: Array<{ file: string; experimental: boolean }> = []
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name)
    if (entry.isFile() && entry.name.endsWith('.json')) {
      result.push({ file: full, experimental: false })
    } else if (entry.isDirectory() && entry.name === 'experimental' && includeExperimental) {
      for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
        if (inner.isFile() && inner.name.endsWith('.json')) {
          result.push({ file: path.join(full, inner.name), experimental: true })
        }
      }
    }
  }
  return result
}

export function validateMacroDefinition(raw: unknown, sourcePath: string, experimental: boolean): MacroDefinition {
  if (!raw || typeof raw !== 'object') throw new Error('macro must be a JSON object')
  const obj = raw as Record<string, unknown>
  const name = obj.name
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(name)) {
    throw new Error('macro.name must be a non-empty string matching /^[a-z][a-z0-9-]*$/i')
  }
  const description = obj.description
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`macro.description must be a non-empty string (for the agent's prompt)`)
  }
  const rawParams = Array.isArray(obj.params) ? obj.params : []
  const params: MacroParamSpec[] = []
  const paramNames = new Set<string>()
  for (const p of rawParams) {
    if (!p || typeof p !== 'object') throw new Error('each macro param must be an object')
    const pn = (p as Record<string, unknown>).name
    if (typeof pn !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(pn)) {
      throw new Error(`macro param name must match /^[a-z][a-z0-9_]*$/i, got ${String(pn)}`)
    }
    if (paramNames.has(pn)) throw new Error(`duplicate macro param: ${pn}`)
    paramNames.add(pn)
    const spec: MacroParamSpec = { name: pn }
    if (typeof (p as Record<string, unknown>).description === 'string') {
      spec.description = (p as Record<string, unknown>).description as string
    }
    if (typeof (p as Record<string, unknown>).required === 'boolean') {
      spec.required = (p as Record<string, unknown>).required as boolean
    }
    params.push(spec)
  }

  const rawSteps = obj.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('macro.steps must be a non-empty array')
  }
  if (rawSteps.length > MAX_MACRO_STEPS) {
    throw new Error(`macro.steps has ${rawSteps.length} entries, max ${MAX_MACRO_STEPS}. Split the macro.`)
  }
  const steps: MacroStep[] = []
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i]
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`macro.steps[${i}] must be an object`)
    }
    const action = (step as Record<string, unknown>).action
    if (typeof action !== 'string' || !SAFE_MACRO_STEP_TYPES.has(action as Action['action'])) {
      throw new Error(
        `macro.steps[${i}].action "${String(action)}" is not in the safe-macro whitelist. ` +
        `Allowed: ${[...SAFE_MACRO_STEP_TYPES].join(', ')}`,
      )
    }
    validateStepTemplates(step as Record<string, unknown>, paramNames, i)
    steps.push(step as MacroStep)
  }

  return {
    name,
    description,
    params,
    steps,
    sourcePath,
    ...(experimental ? { experimental: true } : {}),
  }
}

/** Walk a step's string fields and ensure every `${foo}` matches a declared
 * param. We don't support nested interpolation, math, or anything fancy —
 * just a literal `${name}` token. */
function validateStepTemplates(step: Record<string, unknown>, paramNames: Set<string>, index: number): void {
  const re = /\$\{([a-z][a-z0-9_]*)\}/gi
  for (const [key, value] of Object.entries(step)) {
    if (typeof value !== 'string') continue
    let match: RegExpExecArray | null
    while ((match = re.exec(value)) !== null) {
      const name = match[1]
      if (!paramNames.has(name)) {
        throw new Error(
          `macro.steps[${index}].${key} references undeclared param \${${name}} — add it to params[] or remove the template`,
        )
      }
    }
  }
}

/** Render the loaded macros into the system-prompt snippet. Called once at
 * runner boot and cached in the brain. Returns empty string if no macros. */
export function renderMacroPromptBlock(macros: MacroDefinition[]): string {
  const available = macros.filter((m) => !m.experimental)
  if (available.length === 0) return ''
  const lines: string[] = []
  lines.push('')
  lines.push('USER MACROS (invoke via {"action":"macro","name":"<name>","args":{...}}):')
  for (const macro of available) {
    const paramList = macro.params.length > 0
      ? ` args: { ${macro.params.map((p) => `${p.name}${p.required === false ? '?' : ''}: string`).join(', ')} }`
      : ''
    lines.push(`- ${macro.name} — ${macro.description}${paramList}`)
  }
  return lines.join('\n')
}

/** Substitute `${param}` placeholders in string-typed fields of a step,
 * using the provided args. Returns a new object — does not mutate input.
 * Unknown placeholders are collected so the dispatcher can fail fast
 * instead of silently typing a literal `${missing}` into a form. */
export function interpolateStep(
  step: MacroStep,
  args: Record<string, string>,
): { step: MacroStep; unresolved: string[] } {
  const unresolved = new Set<string>()
  const entries = Object.entries(step).map(([k, v]) => {
    if (typeof v !== 'string') return [k, v] as const
    return [k, v.replace(/\$\{([a-z][a-z0-9_]*)\}/gi, (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(args, name)) return args[name]
      unresolved.add(name)
      return match
    })] as const
  })
  return {
    step: Object.fromEntries(entries) as MacroStep,
    unresolved: [...unresolved],
  }
}

export function buildMacroRegistry(macros: MacroDefinition[]): MacroRegistry {
  const map = new Map<string, MacroDefinition>()
  for (const macro of macros) map.set(macro.name, macro)
  return {
    macros: map,
    promptBlock: renderMacroPromptBlock(macros),
  }
}
