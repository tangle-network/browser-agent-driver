import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

// Auto-run guard MUST be set before importing rollup.ts so main() doesn't
// fire and call process.exit / read CLI args during the test.
process.env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN = '1'

const { buildRemoteUrl } = await import('../bench/telemetry/rollup.js')

const ROLLUP_PATH = path.resolve(__dirname, '..', 'bench', 'telemetry', 'rollup.ts')

describe('rollup --remote URL building', () => {
  it('appends repo, kind, since, until query params when set', () => {
    const url = buildRemoteUrl('https://collector.example/api/telemetry/v1/rollup', {
      baseDir: '/tmp',
      json: false,
      raw: false,
      remote: true,
      repo: 'browser-agent-driver',
      kind: 'design-audit-page',
      since: '2026-04-01',
      until: '2026-04-30',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://collector.example/api/telemetry/v1/rollup')
    expect(parsed.searchParams.get('repo')).toBe('browser-agent-driver')
    expect(parsed.searchParams.get('kind')).toBe('design-audit-page')
    expect(parsed.searchParams.get('since')).toBe('2026-04-01')
    expect(parsed.searchParams.get('until')).toBe('2026-04-30')
  })

  it('omits unset filters', () => {
    const url = buildRemoteUrl('https://collector.example/api/telemetry/v1/rollup', {
      baseDir: '/tmp',
      json: false,
      raw: false,
      remote: true,
    })
    const parsed = new URL(url)
    expect([...parsed.searchParams.keys()]).toEqual([])
  })

  it('appends cursor when supplied (envelopes pagination)', () => {
    const url = buildRemoteUrl(
      'https://x/api/telemetry/v1/envelopes',
      { baseDir: '/tmp', json: false, raw: false, remote: true, repo: 'bad-app' },
      'telemetry/bad-app/2026-04-25/evt-3.json',
    )
    const parsed = new URL(url)
    expect(parsed.searchParams.get('cursor')).toBe('telemetry/bad-app/2026-04-25/evt-3.json')
    expect(parsed.searchParams.get('repo')).toBe('bad-app')
  })
})

describe('rollup --remote env requirements', () => {
  it('exits with code 2 and clear error when BAD_TELEMETRY_API is missing', () => {
    const env = { ...process.env }
    delete env.BAD_TELEMETRY_API
    delete env.BAD_TELEMETRY_ADMIN_BEARER
    delete env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
    const out = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', ROLLUP_PATH, '--remote'],
      { encoding: 'utf-8', env },
    )
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('BAD_TELEMETRY_API')
  })

  it('exits with code 2 when BAD_TELEMETRY_ADMIN_BEARER is missing', () => {
    const env = { ...process.env, BAD_TELEMETRY_API: 'https://collector.example' }
    delete env.BAD_TELEMETRY_ADMIN_BEARER
    delete env.BAD_TELEMETRY_ROLLUP_NO_AUTORUN
    const out = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', ROLLUP_PATH, '--remote'],
      { encoding: 'utf-8', env },
    )
    expect(out.status).toBe(2)
    expect(out.stderr).toContain('BAD_TELEMETRY_ADMIN_BEARER')
  })
})
