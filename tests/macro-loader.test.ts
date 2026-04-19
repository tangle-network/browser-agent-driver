import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  validateMacroDefinition,
  loadMacros,
  buildMacroRegistry,
  renderMacroPromptBlock,
  interpolateStep,
  defaultMacrosRoot,
  SAFE_MACRO_STEP_TYPES,
} from '../src/skills/macro-loader.js'
import type { MacroStep } from '../src/skills/macro-loader.js'

describe('macro-loader — validateMacroDefinition', () => {
  it('accepts a minimal valid macro', () => {
    const raw = {
      name: 'simple',
      description: 'does a thing',
      params: [],
      steps: [{ action: 'wait', ms: 100 }],
    }
    const out = validateMacroDefinition(raw, '/tmp/simple.json', false)
    expect(out.name).toBe('simple')
    expect(out.steps).toHaveLength(1)
    expect(out.experimental).toBeUndefined()
  })

  it('flags experimental when loaded from staging', () => {
    const raw = {
      name: 'exp',
      description: 'staging',
      params: [],
      steps: [{ action: 'wait', ms: 50 }],
    }
    const out = validateMacroDefinition(raw, '/tmp/exp.json', true)
    expect(out.experimental).toBe(true)
  })

  it('rejects unknown step types', () => {
    const raw = {
      name: 'bad',
      description: 'x',
      params: [],
      steps: [{ action: 'navigate', url: 'http://example.com' }],
    }
    expect(() => validateMacroDefinition(raw, '/tmp/x.json', false)).toThrow(/navigate.*not in the safe-macro whitelist/)
  })

  it('rejects nested macros (cannot call macro from macro)', () => {
    const raw = {
      name: 'nested',
      description: 'x',
      params: [],
      steps: [{ action: 'macro', name: 'other' }],
    }
    expect(() => validateMacroDefinition(raw, '/tmp/nested.json', false)).toThrow(/not in the safe-macro whitelist/)
  })

  it('rejects references to undeclared params', () => {
    const raw = {
      name: 'oops',
      description: 'x',
      params: [{ name: 'declared' }],
      steps: [{ action: 'click', selector: '${undeclared}' }],
    }
    expect(() => validateMacroDefinition(raw, '/tmp/oops.json', false)).toThrow(/undeclared param.*undeclared/)
  })

  it('rejects empty steps', () => {
    const raw = { name: 'empty', description: 'x', params: [], steps: [] }
    expect(() => validateMacroDefinition(raw, '/tmp/e.json', false)).toThrow(/non-empty array/)
  })

  it('rejects malformed names', () => {
    const raw = { name: '1invalid', description: 'x', params: [], steps: [{ action: 'wait', ms: 1 }] }
    expect(() => validateMacroDefinition(raw, '/tmp/x.json', false)).toThrow(/macro.name/)
  })

  it('rejects duplicate param names', () => {
    const raw = {
      name: 'dup',
      description: 'x',
      params: [{ name: 'x' }, { name: 'x' }],
      steps: [{ action: 'wait', ms: 1 }],
    }
    expect(() => validateMacroDefinition(raw, '/tmp/dup.json', false)).toThrow(/duplicate macro param/)
  })

  it('accepts all SAFE_MACRO_STEP_TYPES but rejects the rest', () => {
    for (const action of SAFE_MACRO_STEP_TYPES) {
      const minimalStep = minimalStepFor(action)
      const raw = {
        name: `ok-${action}`.replace(/[^a-z0-9-]/g, '-'),
        description: 'x',
        params: [],
        steps: [minimalStep],
      }
      expect(() => validateMacroDefinition(raw, '/tmp/x.json', false)).not.toThrow()
    }
    // Explicitly deny navigate/complete/abort/macro/runScript/evaluate/extractWithIndex/verifyPreview
    for (const disallowed of ['navigate', 'complete', 'abort', 'macro', 'runScript', 'evaluate', 'extractWithIndex', 'verifyPreview']) {
      const raw = {
        name: 'denied',
        description: 'x',
        params: [],
        steps: [{ action: disallowed }],
      }
      expect(() => validateMacroDefinition(raw, '/tmp/x.json', false)).toThrow(/not in the safe-macro whitelist/)
    }
  })
})

function minimalStepFor(action: string): Record<string, unknown> {
  switch (action) {
    case 'click':
    case 'hover':
      return { action, selector: 'ref-abc' }
    case 'type':
      return { action, selector: 'ref-abc', text: 'hello' }
    case 'press':
      return { action, selector: 'ref-abc', key: 'Enter' }
    case 'select':
      return { action, selector: 'ref-abc', value: 'x' }
    case 'scroll':
      return { action, direction: 'down' }
    case 'wait':
      return { action, ms: 100 }
    case 'clickAt':
      return { action, x: 100, y: 100 }
    case 'typeAt':
      return { action, x: 100, y: 100, text: 'hi' }
    case 'clickLabel':
      return { action, label: 1 }
    case 'typeLabel':
      return { action, label: 1, text: 'hi' }
    case 'clickSequence':
      return { action, refs: ['ref-a', 'ref-b'] }
    case 'fill':
      return { action, fields: { ref1: 'v1' } }
    default:
      return { action }
  }
}

describe('macro-loader — interpolateStep', () => {
  it('substitutes ${param} tokens in string fields', () => {
    const step: MacroStep = { action: 'click', selector: '${ref}' }
    const out = interpolateStep(step, { ref: 'ref-abc' })
    expect(out.step).toEqual({ action: 'click', selector: 'ref-abc' })
    expect(out.unresolved).toEqual([])
  })

  it('leaves non-string fields untouched', () => {
    const step: MacroStep = { action: 'wait', ms: 500 }
    const out = interpolateStep(step, { ref: 'anything' })
    expect(out.step).toEqual({ action: 'wait', ms: 500 })
    expect(out.unresolved).toEqual([])
  })

  it('substitutes across multiple fields', () => {
    const step: MacroStep = { action: 'type', selector: '${ref}', text: '${q}' }
    const out = interpolateStep(step, { ref: 'r1', q: 'hello' })
    expect(out.step).toEqual({ action: 'type', selector: 'r1', text: 'hello' })
    expect(out.unresolved).toEqual([])
  })

  it('reports unresolved placeholders so the dispatcher can fail fast', () => {
    const step: MacroStep = { action: 'click', selector: '${missing}' }
    const out = interpolateStep(step, {})
    expect((out.step as { selector: string }).selector).toBe('${missing}')
    expect(out.unresolved).toEqual(['missing'])
  })

  it('deduplicates unresolved placeholders', () => {
    const step: MacroStep = { action: 'type', selector: '${missing}', text: '${missing}' }
    const out = interpolateStep(step, {})
    expect(out.unresolved).toEqual(['missing'])
  })
})

describe('macro-loader — loadMacros', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-macros-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty when root does not exist', async () => {
    const out = await loadMacros({ rootDir: path.join(tmpRoot, 'missing') })
    expect(out.macros).toEqual([])
    expect(out.errors).toEqual([])
  })

  it('loads every *.json under the root', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'a.json'), JSON.stringify({
      name: 'a',
      description: 'first',
      params: [],
      steps: [{ action: 'wait', ms: 1 }],
    }))
    fs.writeFileSync(path.join(tmpRoot, 'b.json'), JSON.stringify({
      name: 'b',
      description: 'second',
      params: [],
      steps: [{ action: 'wait', ms: 1 }],
    }))
    const out = await loadMacros({ rootDir: tmpRoot })
    expect(out.macros.map((m) => m.name).sort()).toEqual(['a', 'b'])
  })

  it('skips experimental/ unless includeExperimental is true', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'experimental'), { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, 'experimental', 'wip.json'), JSON.stringify({
      name: 'wip',
      description: 'x',
      params: [],
      steps: [{ action: 'wait', ms: 1 }],
    }))
    const off = await loadMacros({ rootDir: tmpRoot })
    expect(off.macros).toHaveLength(0)
    const on = await loadMacros({ rootDir: tmpRoot, includeExperimental: true })
    expect(on.macros).toHaveLength(1)
    expect(on.macros[0].experimental).toBe(true)
  })

  it('rejects duplicate names across files', async () => {
    const payload = { name: 'dupe', description: 'x', params: [], steps: [{ action: 'wait', ms: 1 }] }
    fs.writeFileSync(path.join(tmpRoot, 'a.json'), JSON.stringify(payload))
    fs.writeFileSync(path.join(tmpRoot, 'b.json'), JSON.stringify(payload))
    const out = await loadMacros({ rootDir: tmpRoot, onError: () => {} })
    expect(out.macros).toHaveLength(1)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].error).toMatch(/Duplicate/)
  })

  it('captures parse errors without throwing', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'broken.json'), '{ not json')
    const out = await loadMacros({ rootDir: tmpRoot, onError: () => {} })
    expect(out.macros).toHaveLength(0)
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].path).toContain('broken')
  })
})

describe('macro-loader — renderMacroPromptBlock', () => {
  it('produces empty string when no non-experimental macros', () => {
    expect(renderMacroPromptBlock([])).toBe('')
    expect(renderMacroPromptBlock([{
      name: 'exp',
      description: 'x',
      params: [],
      steps: [{ action: 'wait', ms: 1 }],
      sourcePath: '/x',
      experimental: true,
    }])).toBe('')
  })

  it('lists each macro with its exact signature', () => {
    const block = renderMacroPromptBlock([
      { name: 'click-x', description: 'clicks X', params: [], steps: [{ action: 'wait', ms: 1 }], sourcePath: '/x' },
      { name: 'search', description: 'search', params: [{ name: 'q', required: true }], steps: [{ action: 'wait', ms: 1 }], sourcePath: '/y' },
    ])
    const expected = [
      '',
      'USER MACROS (invoke via {"action":"macro","name":"<name>","args":{...}}):',
      '- click-x — clicks X',
      '- search — search args: { q: string }',
    ].join('\n')
    expect(block).toBe(expected)
  })
})

describe('macro-loader — buildMacroRegistry', () => {
  it('returns a map keyed by name + prompt block', () => {
    const reg = buildMacroRegistry([
      { name: 'a', description: 'd', params: [], steps: [{ action: 'wait', ms: 1 }], sourcePath: '/a' },
    ])
    expect(reg.macros.get('a')?.name).toBe('a')
    expect(reg.promptBlock).toMatch(/USER MACROS/)
  })
})

describe('macro-loader — BAD_MACROS_DIR env override', () => {
  it('defaultMacrosRoot honors process.env.BAD_MACROS_DIR', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-macros-env-'))
    const prior = process.env.BAD_MACROS_DIR
    try {
      process.env.BAD_MACROS_DIR = tmp
      expect(defaultMacrosRoot()).toBe(path.resolve(tmp))
    } finally {
      if (prior === undefined) delete process.env.BAD_MACROS_DIR
      else process.env.BAD_MACROS_DIR = prior
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('defaultMacrosRoot falls back to packaged path when env unset', () => {
    const prior = process.env.BAD_MACROS_DIR
    try {
      delete process.env.BAD_MACROS_DIR
      const out = defaultMacrosRoot()
      expect(out).toMatch(/skills[\/\\]macros$/)
    } finally {
      if (prior !== undefined) process.env.BAD_MACROS_DIR = prior
    }
  })
})

describe('macro-loader — shipped seed corpus', () => {
  it('the seeded macros parse cleanly', async () => {
    const out = await loadMacros({ rootDir: defaultMacrosRoot() })
    const names = out.macros.map((m) => m.name).sort()
    expect(names).toEqual(expect.arrayContaining(['dismiss-cookie-banner', 'search-and-submit']))
    expect(out.errors).toEqual([])
  })
})
