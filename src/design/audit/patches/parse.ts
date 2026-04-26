/**
 * Patch parser — converts raw LLM JSON output into typed `Patch` objects.
 *
 * Strict shape validation. On schema mismatch returns `{ patch: null, reason }`
 * rather than throwing — the calling pipeline batches many candidate patches
 * per audit and a single malformed entry must not abort the whole run.
 */

import type {
  Patch,
  PatchRollback,
  PatchRollbackKind,
  PatchTarget,
  PatchTest,
  PatchTestKind,
  ConfidenceLevel,
  Dimension,
} from '../v2/types.js'

type PatchScope = 'page' | 'section' | 'component' | 'system'
type PatchTargetScope = 'tsx' | 'jsx' | 'css' | 'tailwind' | 'module-css' | 'styled-component' | 'structural' | 'html'
type PatchDeltaConfidence = ConfidenceLevel | 'untested'

const VALID_SCOPES: PatchScope[] = ['page', 'section', 'component', 'system']
const VALID_TARGET_SCOPES: PatchTargetScope[] = [
  'tsx', 'jsx', 'css', 'tailwind', 'module-css', 'styled-component', 'structural', 'html',
]
const VALID_TEST_KINDS: PatchTestKind[] = [
  'storybook', 'a11y-rule', 'visual-snapshot', 'unit', 'rerun-audit', 'manual',
]
const VALID_ROLLBACK_KINDS: PatchRollbackKind[] = ['git-revert', 'css-disable', 'manual']
const VALID_CONFIDENCES: PatchDeltaConfidence[] = ['high', 'medium', 'low', 'untested']

export interface ParseResult {
  patch: Patch | null
  reason?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function parseTarget(raw: unknown): PatchTarget | string {
  if (!isObject(raw)) return 'target: not an object'
  if (!oneOf(raw.scope, VALID_TARGET_SCOPES)) return `target.scope: invalid (got ${String(raw.scope)})`
  const target: PatchTarget = { scope: raw.scope }
  if (raw.filePath !== undefined) {
    if (!isString(raw.filePath)) return 'target.filePath: must be non-empty string'
    target.filePath = raw.filePath
  }
  if (raw.componentName !== undefined) {
    if (!isString(raw.componentName)) return 'target.componentName: must be non-empty string'
    target.componentName = raw.componentName
  }
  if (raw.cssSelector !== undefined) {
    if (!isString(raw.cssSelector)) return 'target.cssSelector: must be non-empty string'
    target.cssSelector = raw.cssSelector
  }
  return target
}

function parseTest(raw: unknown): PatchTest | string {
  if (!isObject(raw)) return 'testThatProves: not an object'
  if (!oneOf(raw.kind, VALID_TEST_KINDS)) return `testThatProves.kind: invalid (got ${String(raw.kind)})`
  if (!isString(raw.description)) return 'testThatProves.description: must be non-empty string'
  const test: PatchTest = { kind: raw.kind, description: raw.description }
  if (raw.command !== undefined) {
    if (typeof raw.command !== 'string') return 'testThatProves.command: must be string when present'
    test.command = raw.command
  }
  return test
}

function parseRollback(raw: unknown): PatchRollback | string {
  if (!isObject(raw)) return 'rollback: not an object'
  if (!oneOf(raw.kind, VALID_ROLLBACK_KINDS)) return `rollback.kind: invalid (got ${String(raw.kind)})`
  const rollback: PatchRollback = { kind: raw.kind }
  if (raw.instruction !== undefined) {
    if (typeof raw.instruction !== 'string') return 'rollback.instruction: must be string when present'
    rollback.instruction = raw.instruction
  }
  return rollback
}

/**
 * Parse a single raw LLM-produced object into a `Patch`. Returns
 * `{ patch: null, reason }` on any schema violation.
 */
export function parsePatch(raw: unknown): ParseResult {
  if (!isObject(raw)) return { patch: null, reason: 'patch: not an object' }
  if (!isString(raw.patchId)) return { patch: null, reason: 'patchId: required non-empty string' }
  if (!isString(raw.findingId)) return { patch: null, reason: 'findingId: required non-empty string' }
  if (!oneOf(raw.scope, VALID_SCOPES)) return { patch: null, reason: `scope: invalid (got ${String(raw.scope)})` }

  const target = parseTarget(raw.target)
  if (typeof target === 'string') return { patch: null, reason: target }

  if (!isObject(raw.diff)) return { patch: null, reason: 'diff: not an object' }
  if (!isString(raw.diff.before)) return { patch: null, reason: 'diff.before: required non-empty string' }
  if (typeof raw.diff.after !== 'string') return { patch: null, reason: 'diff.after: required string' }
  const diff = {
    before: raw.diff.before,
    after: raw.diff.after,
    ...(typeof raw.diff.unifiedDiff === 'string' ? { unifiedDiff: raw.diff.unifiedDiff } : {}),
  }

  const test = parseTest(raw.testThatProves)
  if (typeof test === 'string') return { patch: null, reason: test }

  const rollback = parseRollback(raw.rollback)
  if (typeof rollback === 'string') return { patch: null, reason: rollback }

  if (!isObject(raw.estimatedDelta)) return { patch: null, reason: 'estimatedDelta: not an object' }
  if (!isString(raw.estimatedDelta.dim)) return { patch: null, reason: 'estimatedDelta.dim: required' }
  if (typeof raw.estimatedDelta.delta !== 'number' || !Number.isFinite(raw.estimatedDelta.delta)) {
    return { patch: null, reason: 'estimatedDelta.delta: must be finite number' }
  }

  if (!oneOf(raw.estimatedDeltaConfidence, VALID_CONFIDENCES)) {
    return { patch: null, reason: `estimatedDeltaConfidence: invalid (got ${String(raw.estimatedDeltaConfidence)})` }
  }

  const patch: Patch = {
    patchId: raw.patchId,
    findingId: raw.findingId,
    scope: raw.scope,
    target,
    diff,
    testThatProves: test,
    rollback,
    estimatedDelta: { dim: raw.estimatedDelta.dim as Dimension, delta: raw.estimatedDelta.delta },
    estimatedDeltaConfidence: raw.estimatedDeltaConfidence,
    ...(typeof raw.matchedPatternId === 'string' ? { matchedPatternId: raw.matchedPatternId } : {}),
  }
  return { patch }
}

/**
 * Parse an array of raw patch objects. Invalid entries are dropped from the
 * returned `patches` and reported in `errors` with their original index.
 */
export function parsePatches(raw: unknown): {
  patches: Patch[]
  errors: Array<{ index: number; reason: string }>
} {
  if (!Array.isArray(raw)) {
    return { patches: [], errors: [{ index: -1, reason: 'patches: not an array' }] }
  }
  const patches: Patch[] = []
  const errors: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < raw.length; i++) {
    const result = parsePatch(raw[i])
    if (result.patch) patches.push(result.patch)
    else errors.push({ index: i, reason: result.reason ?? 'unknown' })
  }
  return { patches, errors }
}
