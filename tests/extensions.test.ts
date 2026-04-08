/**
 * Tests for the extension API: shape validation, multi-extension merging,
 * domain rule matching, mutateDecision short-circuit, and loader behavior.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  isBadExtension,
  resolveExtensions,
  rulesForUrl,
  type BadExtension,
} from '../src/extensions/types.js'
import { loadExtensions } from '../src/extensions/loader.js'
import type { TurnEvent } from '../src/runner/events.js'
import type { BrainDecision } from '../src/brain/index.js'

describe('isBadExtension', () => {
  it('accepts an empty object as a no-op extension', () => {
    expect(isBadExtension({})).toBe(true)
  })

  it('accepts an extension with only addRules', () => {
    expect(isBadExtension({ addRules: { search: 'be careful' } })).toBe(true)
  })

  it('rejects null and primitives', () => {
    expect(isBadExtension(null)).toBe(false)
    expect(isBadExtension('string')).toBe(false)
    expect(isBadExtension(42)).toBe(false)
  })

  it('rejects an object with a non-function onTurnEvent', () => {
    expect(isBadExtension({ onTurnEvent: 'not a function' })).toBe(false)
  })

  it('rejects an object with a non-array addAuditFragments', () => {
    expect(isBadExtension({ addAuditFragments: 'oops' })).toBe(false)
  })

  it('accepts a fully populated extension', () => {
    const ext: BadExtension = {
      onTurnEvent: () => {},
      mutateDecision: (d) => d,
      addRules: { search: 'rule' },
      addRulesForDomain: { 'stripe.com': { extraRules: 'go to dashboard' } },
      addAuditFragments: [
        { id: 'x', title: 'X', weight: 'high', body: 'body', appliesWhen: {} },
      ],
    }
    expect(isBadExtension(ext)).toBe(true)
  })
})

describe('resolveExtensions — fanOutTurnEvent', () => {
  it('fans out to every extension that registered onTurnEvent', () => {
    const a: TurnEvent[] = []
    const b: TurnEvent[] = []
    const resolved = resolveExtensions([
      { onTurnEvent: (e) => a.push(e) },
      { onTurnEvent: (e) => b.push(e) },
      {}, // no-op
    ])
    const event: TurnEvent = {
      type: 'turn-started',
      seq: 1,
      ts: '2026-04-07T00:00:00Z',
      runId: 'r1',
      turn: 1,
    }
    resolved.fanOutTurnEvent(event)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('catches listener errors so a bad extension does not crash siblings', () => {
    const survivor: TurnEvent[] = []
    const resolved = resolveExtensions([
      {
        onTurnEvent: () => {
          throw new Error('bad ext')
        },
      },
      { onTurnEvent: (e) => survivor.push(e) },
    ])
    expect(() =>
      resolved.fanOutTurnEvent({
        type: 'turn-started',
        seq: 1,
        ts: '2026-04-07T00:00:00Z',
        runId: 'r1',
        turn: 1,
      }),
    ).not.toThrow()
    expect(survivor).toHaveLength(1)
  })
})

describe('resolveExtensions — combinedRules', () => {
  it('concatenates same-section rules from multiple extensions', () => {
    const resolved = resolveExtensions([
      { addRules: { search: 'rule A' } },
      { addRules: { search: 'rule B' } },
    ])
    expect(resolved.combinedRules.search).toBe('rule A\n\nrule B')
  })

  it('preserves separate sections independently', () => {
    const resolved = resolveExtensions([
      { addRules: { search: 'search rule', heavy: 'heavy rule' } },
    ])
    expect(resolved.combinedRules.search).toBe('search rule')
    expect(resolved.combinedRules.heavy).toBe('heavy rule')
  })
})

describe('resolveExtensions — combinedDomainRules', () => {
  it('concatenates same-domain rules from multiple extensions', () => {
    const resolved = resolveExtensions([
      { addRulesForDomain: { 'stripe.com': { extraRules: 'rule A' } } },
      { addRulesForDomain: { 'stripe.com': { extraRules: 'rule B' } } },
    ])
    expect(resolved.combinedDomainRules['stripe.com'].extraRules).toBe('rule A\n\nrule B')
  })

  it('keeps different domains independent', () => {
    const resolved = resolveExtensions([
      {
        addRulesForDomain: {
          'stripe.com': { extraRules: 'stripe rule' },
          'github.com': { extraRules: 'github rule' },
        },
      },
    ])
    expect(resolved.combinedDomainRules['stripe.com'].extraRules).toBe('stripe rule')
    expect(resolved.combinedDomainRules['github.com'].extraRules).toBe('github rule')
  })
})

describe('rulesForUrl', () => {
  it('matches a host as a substring', () => {
    const rules = rulesForUrl('https://dashboard.stripe.com/payments', {
      'stripe.com': { extraRules: 'stripe rule' },
    })
    expect(rules).toBe('stripe rule')
  })

  it('returns undefined when no domain matches', () => {
    const rules = rulesForUrl('https://example.com', {
      'stripe.com': { extraRules: 'stripe rule' },
    })
    expect(rules).toBeUndefined()
  })

  it('concatenates multiple matching domains', () => {
    const rules = rulesForUrl('https://stripe.com', {
      'stripe.com': { extraRules: 'rule 1' },
      '.com': { extraRules: 'rule 2' },
    })
    expect(rules).toContain('rule 1')
    expect(rules).toContain('rule 2')
  })

  it('returns undefined for an invalid URL', () => {
    expect(rulesForUrl('not-a-url', { 'a.com': { extraRules: 'r' } })).toBeUndefined()
  })
})

describe('resolveExtensions — applyMutateDecision', () => {
  const baseDecision: BrainDecision = {
    action: { action: 'click', selector: '@b1' },
    raw: '{}',
  }
  const ctx = {
    goal: 'g',
    turn: 1,
    maxTurns: 10,
    state: { url: 'https://example.com', title: 'T', snapshot: '' },
  }

  it('returns the original decision when no extension mutates', () => {
    const resolved = resolveExtensions([{}])
    const result = resolved.applyMutateDecision(baseDecision, ctx)
    expect(result.mutated).toBe(false)
    expect(result.decision).toBe(baseDecision)
  })

  it('applies a mutation that returns a new action', () => {
    const resolved = resolveExtensions([
      {
        mutateDecision: (d) => ({
          ...d,
          action: { action: 'click', selector: '@b2' },
        }),
      },
    ])
    const result = resolved.applyMutateDecision(baseDecision, ctx)
    expect(result.mutated).toBe(true)
    expect(result.decision.action).toEqual({ action: 'click', selector: '@b2' })
    expect(result.sources).toEqual(['extension[0]'])
  })

  it('chains mutations across multiple extensions in registration order', () => {
    const resolved = resolveExtensions([
      {
        mutateDecision: (d) => ({
          ...d,
          action: { action: 'click', selector: '@b2' },
        }),
      },
      {
        mutateDecision: (d) => ({
          ...d,
          action: { action: 'click', selector: '@b3' },
        }),
      },
    ])
    const result = resolved.applyMutateDecision(baseDecision, ctx)
    expect(result.decision.action).toEqual({ action: 'click', selector: '@b3' })
    expect(result.sources).toEqual(['extension[0]', 'extension[1]'])
  })

  it('catches mutation errors and continues with the previous decision', () => {
    const resolved = resolveExtensions([
      {
        mutateDecision: () => {
          throw new Error('bad mutation')
        },
      },
      {
        mutateDecision: (d) => ({
          ...d,
          action: { action: 'click', selector: '@b4' },
        }),
      },
    ])
    const result = resolved.applyMutateDecision(baseDecision, ctx)
    expect(result.decision.action).toEqual({ action: 'click', selector: '@b4' })
  })
})

describe('loadExtensions', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-ext-test-'))
  })

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns an empty resolved bundle when no config exists', async () => {
    const result = await loadExtensions({ cwd: tmpDir })
    expect(result.loadedFrom).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.resolved.extensions).toEqual([])
  })

  it('auto-discovers bad.config.mjs from cwd', async () => {
    const configPath = path.join(tmpDir, 'bad.config.mjs')
    fs.writeFileSync(
      configPath,
      `export default { addRules: { search: 'auto-loaded rule' } }\n`,
    )
    const result = await loadExtensions({ cwd: tmpDir })
    expect(result.loadedFrom).toEqual([configPath])
    expect(result.errors).toEqual([])
    expect(result.resolved.combinedRules.search).toBe('auto-loaded rule')
    fs.unlinkSync(configPath)
  })

  it('reports load errors without crashing', async () => {
    // Use a unique sub-directory so Node's ESM import cache doesn't reuse
    // a previously-loaded module at the same path.
    const errSubdir = fs.mkdtempSync(path.join(tmpDir, 'err-case-'))
    const configPath = path.join(errSubdir, 'bad.config.mjs')
    fs.writeFileSync(configPath, `export default 42\n`) // invalid shape
    const errors: Array<{ path: string; error: unknown }> = []
    const result = await loadExtensions({
      cwd: errSubdir,
      onError: (p, err) => errors.push({ path: p, error: err }),
    })
    expect(result.loadedFrom).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })

  it('loads explicit --extension paths in addition to auto-discovery', async () => {
    const explicitPath = path.join(tmpDir, 'extra-ext.mjs')
    fs.writeFileSync(
      explicitPath,
      `export default { addRules: { heavy: 'explicit rule' } }\n`,
    )
    const result = await loadExtensions({
      cwd: tmpDir,
      explicitPaths: [explicitPath],
    })
    expect(result.loadedFrom).toContain(explicitPath)
    expect(result.resolved.combinedRules.heavy).toBe('explicit rule')
    fs.unlinkSync(explicitPath)
  })
})
