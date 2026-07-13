import { describe, it, expect } from 'vitest'
import { loadOptionalModule } from '../src/optional-dependency.js'

describe('loadOptionalModule', () => {
  it('returns the module when the optional dependency is present', async () => {
    const mod = await loadOptionalModule(
      () => import('node:path'),
      'node:path',
      'the path helper',
    )
    expect(typeof mod.join).toBe('function')
  })

  it('maps a missing optional dependency to an actionable error', async () => {
    const missing = Object.assign(
      new Error("Cannot find package 'ai-sdk-provider-codex-cli'"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    await expect(
      loadOptionalModule(
        () => Promise.reject(missing),
        'ai-sdk-provider-codex-cli',
        "The 'codex-cli' provider",
      ),
    ).rejects.toThrow(
      /The 'codex-cli' provider requires the optional package "ai-sdk-provider-codex-cli".*omit=optional/s,
    )
  })

  it('passes unrelated errors through unchanged', async () => {
    const boom = new Error('kaboom')
    await expect(
      loadOptionalModule(() => Promise.reject(boom), 'some-pkg', 'the thing'),
    ).rejects.toBe(boom)
  })
})
