/**
 * Tests for the bad adapter and the shared oracle evaluator.
 *
 * Both modules are .mjs files with no types; we cast through `unknown`
 * for the imports. The adapter's `runTask` function is NOT exercised
 * here (it spawns a real CLI subprocess) — the live end-to-end test is
 * `pnpm bench:compete --frameworks bad --tasks form-fill-multi-step`.
 *
 * What we test here:
 *   - detect() resolves availability based on dist/cli.js presence
 *   - oracle evaluators correctly classify text-in-snapshot, url-contains,
 *     json-shape-match, and selector-state hits and misses.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error mjs without types
import * as badAdapter from '../bench/competitive/adapters/bad.mjs'
// @ts-expect-error mjs without types
import { evaluateOracle } from '../bench/competitive/adapters/_oracle.mjs'

const repoRoot = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'))

describe('bad adapter — detect()', () => {
  it('returns available=true when dist/cli.js exists', () => {
    const distExists = fs.existsSync(path.join(repoRoot, 'dist', 'cli.js'))
    const result = badAdapter.detect(repoRoot)
    if (distExists) {
      expect(result.available).toBe(true)
      expect(result.version).toBeTruthy()
    } else {
      expect(result.available).toBe(false)
      expect(result.reason).toMatch(/dist\/cli\.js/)
    }
  })

  it('returns available=false for a directory without dist/', () => {
    const result = badAdapter.detect('/tmp')
    expect(result.available).toBe(false)
  })
})

describe('oracle — text-in-snapshot', () => {
  const finalState = {
    finalUrl: 'http://example.com/done',
    finalTitle: 'Done',
    finalSnapshot: '- alert: "Account Created!"\n- button "Go to Dashboard"',
    resultText: 'Submitted the form',
  }

  it('passes when expectedText is in the snapshot', () => {
    const v = evaluateOracle({ type: 'text-in-snapshot', expectedText: 'Account Created!' }, finalState)
    expect(v.passed).toBe(true)
  })

  it('passes case-insensitively', () => {
    const v = evaluateOracle({ type: 'text-in-snapshot', expectedText: 'account created' }, finalState)
    expect(v.passed).toBe(true)
  })

  it('passes when expectedText is in resultText (not snapshot)', () => {
    const v = evaluateOracle({ type: 'text-in-snapshot', expectedText: 'Submitted' }, finalState)
    expect(v.passed).toBe(true)
  })

  it('fails when expectedText is missing from both', () => {
    const v = evaluateOracle({ type: 'text-in-snapshot', expectedText: 'Login Failed' }, finalState)
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/miss/)
  })

  it('fails when expectedText is empty', () => {
    const v = evaluateOracle({ type: 'text-in-snapshot', expectedText: '' }, finalState)
    expect(v.passed).toBe(false)
  })
})

describe('oracle — url-contains', () => {
  const finalState = { finalUrl: 'https://example.com/orders/12345/confirm', finalTitle: '', finalSnapshot: '' }

  it('passes on substring match', () => {
    const v = evaluateOracle({ type: 'url-contains', expectedUrlFragment: '/orders/' }, finalState)
    expect(v.passed).toBe(true)
  })

  it('fails when fragment is absent', () => {
    const v = evaluateOracle({ type: 'url-contains', expectedUrlFragment: '/cart/' }, finalState)
    expect(v.passed).toBe(false)
  })
})

describe('oracle — json-shape-match', () => {
  it('passes when every required key is present and matches', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: '{"score":42,"status":"ok"}' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { score: null, status: 'ok' } },
      finalState,
    )
    expect(v.passed).toBe(true)
  })

  it('passes when value is a regex string starting with re:', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: '{"id":"order-12345"}' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { id: 're:^order-\\d+$' } },
      finalState,
    )
    expect(v.passed).toBe(true)
  })

  it('fails on missing key', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: '{"a":1}' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { b: null } },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/missing key b/)
  })

  it('fails on value mismatch', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: '{"status":"error"}' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { status: 'ok' } },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/value mismatch/)
  })

  it('extracts JSON from a markdown code fence', () => {
    const finalState = {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
      resultText: 'Here is the result:\n```json\n{"score":42}\n```',
    }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { score: 42 } },
      finalState,
    )
    expect(v.passed).toBe(true)
  })

  it('fails when resultText is not JSON', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: 'just plain text' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { score: null } },
      finalState,
    )
    expect(v.passed).toBe(false)
  })
})

describe('oracle — selector-state degrades to text-in-snapshot', () => {
  it('passes when expectedText is in the snapshot', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '- heading "Account Created!"', resultText: '' }
    const v = evaluateOracle(
      { type: 'selector-state', selector: '#result h2', expectedText: 'Account Created!' },
      finalState,
    )
    expect(v.passed).toBe(true)
  })
})

describe('oracle — error cases', () => {
  it('returns failed for unknown oracle type', () => {
    const v = evaluateOracle({ type: 'mystery-oracle' } as unknown as { type: string }, {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
    })
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/unknown/)
  })

  it('returns failed when oracle is missing entirely', () => {
    const v = evaluateOracle(undefined as unknown as { type: string }, {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
    })
    expect(v.passed).toBe(false)
  })
})
