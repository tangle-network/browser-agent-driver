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
import { beforeAll, describe, expect, it } from 'vitest'
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

  it('fails when resultText is the JSON literal `null` (not an object)', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: 'null' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { signature: 're:update\\(' } },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/not a JSON object/)
  })

  it('fails when resultText is a top-level array (not an object)', () => {
    const finalState = { finalUrl: '', finalTitle: '', finalSnapshot: '', resultText: '[1,2,3]' }
    const v = evaluateOracle(
      { type: 'json-shape-match', expectedShape: { x: null } },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/not a JSON object/)
  })

  // Array-shape extension.
  it('passes when an array key matches a fixed-length spec of regex elements', () => {
    const finalState = {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
      resultText: '{"titles": ["Alpha story title", "Beta story two", "Gamma three news"]}',
    }
    const v = evaluateOracle(
      {
        type: 'json-shape-match',
        expectedShape: { titles: ['re:.{5,}', 're:.{5,}', 're:.{5,}'] },
      },
      finalState,
    )
    expect(v.passed).toBe(true)
  })

  it('fails when array length does not match expected length', () => {
    const finalState = {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
      resultText: '{"titles": ["one", "two"]}',
    }
    const v = evaluateOracle(
      {
        type: 'json-shape-match',
        expectedShape: { titles: ['re:.{1,}', 're:.{1,}', 're:.{1,}'] },
      },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/length mismatch/)
  })

  it('fails when array element regex does not match', () => {
    const finalState = {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
      resultText: '{"titles": ["abc", "def", "g"]}',
    }
    const v = evaluateOracle(
      {
        type: 'json-shape-match',
        expectedShape: { titles: ['re:.{2,}', 're:.{2,}', 're:.{2,}'] },
      },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/regex mismatch/)
  })

  it('fails when key is not an array but spec is array', () => {
    const finalState = {
      finalUrl: '',
      finalTitle: '',
      finalSnapshot: '',
      resultText: '{"titles": "not an array"}',
    }
    const v = evaluateOracle(
      {
        type: 'json-shape-match',
        expectedShape: { titles: ['re:.{1,}'] },
      },
      finalState,
    )
    expect(v.passed).toBe(false)
    expect(v.reason).toMatch(/not an array/)
  })
})

describe('detectAntiBotBlock', () => {
  // @ts-expect-error mjs without types
  let detectAntiBotBlock: (finalState: object, runResult: object) => string | null

  beforeAll(async () => {
    const mod = await import('../bench/competitive/adapters/bad.mjs')
    // @ts-expect-error
    detectAntiBotBlock = mod.detectAntiBotBlock
  })

  it('returns null for a clean page', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'https://example.com', finalSnapshot: 'just a normal page', resultText: '' },
        {},
      ),
    ).toBeNull()
  })

  it('detects chrome-error://', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'chrome-error://chromewebdata/', finalSnapshot: '', resultText: '' },
        {},
      ),
    ).toMatch(/chrome-error/)
  })

  it('detects cloudflare interstitial', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'https://x.com', finalSnapshot: 'Just a moment...', resultText: '' },
        {},
      ),
    ).toMatch(/cloudflare/i)
  })

  it('detects "Verifying you are human"', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'https://x.com', finalSnapshot: 'verifying you are human', resultText: '' },
        {},
      ),
    ).toMatch(/cloudflare/i)
  })

  it('detects recaptcha', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'https://x.com', finalSnapshot: 'Please complete the recaptcha', resultText: '' },
        {},
      ),
    ).toMatch(/captcha/i)
  })

  it('detects 403 access-denied banners', () => {
    expect(
      detectAntiBotBlock(
        { finalUrl: 'https://x.com', finalSnapshot: 'Access Denied — your IP is blocked', resultText: '' },
        {},
      ),
    ).toMatch(/access-denied/i)
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
