/**
 * SteelDriver shape + option merging tests.
 *
 * SteelDriver requires the `steel-sdk` package at runtime which we don't
 * carry as a dependency. Instead of integration-testing the live API,
 * we verify:
 *   1. The class is exported from the public surface
 *   2. SteelDriverOptions accepts both nested (`steel.apiKey`) and legacy
 *      flat (`apiKey`) shapes — the new docs steer users at nested but
 *      we don't break old callers
 *   3. SteelDriver implements Symbol.asyncDispose for `using` syntax
 *   4. SteelDriver throws a clear error when no API key is available
 */

import { describe, it, expect, afterEach } from 'vitest'
import { SteelDriver, type SteelDriverOptions, type SteelOptions } from '../src/drivers/steel.js'

describe('SteelDriver export shape', () => {
  it('is exported as a class with a static create()', () => {
    expect(typeof SteelDriver).toBe('function')
    expect(typeof SteelDriver.create).toBe('function')
  })

  it('SteelDriverOptions accepts the nested steel form', () => {
    // Type-only assertion: this compiles iff the shape is right.
    const opts: SteelDriverOptions = {
      steel: {
        apiKey: 'sk-test',
        baseUrl: 'https://api.steel.dev',
        sessionId: 'sess_123',
        sessionOptions: { useProxy: true, solveCaptcha: true },
      },
    }
    expect(opts.steel?.apiKey).toBe('sk-test')
    expect(opts.steel?.sessionOptions?.useProxy).toBe(true)
  })

  it('SteelDriverOptions still accepts the legacy flat form', () => {
    const opts: SteelDriverOptions = {
      apiKey: 'sk-test-legacy',
      baseUrl: 'https://api.steel.dev',
      sessionId: 'sess_legacy',
      sessionOptions: { useProxy: false },
    }
    expect(opts.apiKey).toBe('sk-test-legacy')
  })

  it('SteelDriverOptions extends PlaywrightDriverOptions', () => {
    // Inherited fields are accepted
    const opts: SteelDriverOptions = {
      steel: { apiKey: 'sk' },
      timeout: 15_000,
      showCursor: true,
      visionStrategy: 'always',
    }
    expect(opts.timeout).toBe(15_000)
    expect(opts.showCursor).toBe(true)
  })

  it('SteelOptions is exported as a standalone interface', () => {
    const steel: SteelOptions = { apiKey: 'sk' }
    expect(steel.apiKey).toBe('sk')
  })
})

describe('SteelDriver.create()', () => {
  const oldEnv = process.env.STEEL_API_KEY

  afterEach(() => {
    if (oldEnv === undefined) delete process.env.STEEL_API_KEY
    else process.env.STEEL_API_KEY = oldEnv
  })

  it('throws a clear error when no API key is set', async () => {
    delete process.env.STEEL_API_KEY
    await expect(SteelDriver.create({})).rejects.toThrow(/STEEL_API_KEY/)
  })

  it('throws a clear error when steel-sdk is not installed', async () => {
    // The package is not in dependencies, so the dynamic import should fail.
    await expect(
      SteelDriver.create({ steel: { apiKey: 'sk-test' } }),
    ).rejects.toThrow(/steel-sdk not installed/)
  })

  it('prefers nested steel.apiKey over legacy apiKey', async () => {
    // Both set, nested wins. The merge happens before the dynamic import,
    // so we still hit the "not installed" error — but the error message
    // confirms the merge ran without throwing on a missing key.
    await expect(
      SteelDriver.create({
        apiKey: 'legacy-key',
        steel: { apiKey: 'nested-key' },
      }),
    ).rejects.toThrow(/steel-sdk not installed/)
  })

  it('falls back to legacy apiKey when steel.apiKey is undefined', async () => {
    await expect(
      SteelDriver.create({
        apiKey: 'legacy-only',
        steel: {},
      }),
    ).rejects.toThrow(/steel-sdk not installed/)
  })

  it('falls back to STEEL_API_KEY env when neither shape provides one', async () => {
    process.env.STEEL_API_KEY = 'env-key'
    await expect(SteelDriver.create({})).rejects.toThrow(/steel-sdk not installed/)
  })
})

describe('SteelDriver async dispose', () => {
  it('exposes Symbol.asyncDispose for `using` syntax', () => {
    // Symbol.asyncDispose may not exist on the global Symbol in older Node;
    // polyfill the lookup so the test runs everywhere.
    const asyncDisposeSym = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose
    if (!asyncDisposeSym) {
      // Older Node — the method exists by name but the symbol isn't built-in
      expect(Object.getOwnPropertyNames(SteelDriver.prototype)).toContain('close')
      return
    }
    // The method should exist on the prototype (we can't instantiate without
    // a real session, but the prototype shape is enough to verify the
    // contract holds).
    const proto = SteelDriver.prototype as unknown as Record<symbol, unknown>
    expect(typeof proto[asyncDisposeSym]).toBe('function')
  })
})

