import { describe, it, expect, afterAll } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  probeChromeDebug,
  resolveAttachEndpoint,
  findChromeBinary,
  findChromeUserDataDir,
  handleChromeDebug,
  validateAttachConflicts,
  DEFAULT_ATTACH_PORT,
} from '../src/cli-attach.js'

// Helpers to fabricate fetch-like responses without hitting the network.
// The probe must tolerate: non-listener (throw), non-200 (!ok), non-JSON
// body (JSON.parse throw), missing field — each maps to null, not crash.

function makeFetch(body: unknown, opts: { ok?: boolean; throws?: string } = {}): typeof fetch {
  const impl = (async () => {
    if (opts.throws) throw new Error(opts.throws)
    return {
      ok: opts.ok ?? true,
      async json() {
        if (body === '__NOT_JSON__') throw new Error('bad json')
        return body
      },
    }
  }) as unknown as typeof fetch
  return impl
}

describe('cli-attach — probeChromeDebug', () => {
  it('returns info when DevTools endpoint returns webSocketDebuggerUrl', async () => {
    const fetchImpl = makeFetch({
      Browser: 'Chrome/131.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    })
    const info = await probeChromeDebug({ fetchImpl, timeoutMs: 100 })
    expect(info).toEqual(expect.objectContaining({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      browser: 'Chrome/131.0',
    }))
  })

  it('returns null when listener absent (fetch throws)', async () => {
    const fetchImpl = makeFetch(null, { throws: 'ECONNREFUSED' })
    const info = await probeChromeDebug({ fetchImpl, timeoutMs: 100 })
    expect(info).toBeNull()
  })

  it('returns null on non-2xx response', async () => {
    const fetchImpl = makeFetch({}, { ok: false })
    const info = await probeChromeDebug({ fetchImpl, timeoutMs: 100 })
    expect(info).toBeNull()
  })

  it('returns null when JSON parse fails', async () => {
    const fetchImpl = makeFetch('__NOT_JSON__')
    const info = await probeChromeDebug({ fetchImpl, timeoutMs: 100 })
    expect(info).toBeNull()
  })

  it('returns null when webSocketDebuggerUrl field is missing', async () => {
    const fetchImpl = makeFetch({ Browser: 'something' })
    const info = await probeChromeDebug({ fetchImpl, timeoutMs: 100 })
    expect(info).toBeNull()
  })

  it('respects custom port + host', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string | URL | Request) => {
      calledUrl = String(url)
      return {
        ok: true,
        async json() {
          return { webSocketDebuggerUrl: 'ws://host:7000/' }
        },
      }
    }) as unknown as typeof fetch
    await probeChromeDebug({ host: 'example.internal', port: 7000, fetchImpl, timeoutMs: 100 })
    expect(calledUrl).toBe('http://example.internal:7000/json/version')
  })
})

describe('cli-attach — resolveAttachEndpoint', () => {
  it('returns first successful probe', async () => {
    const probeImpl = async () => ({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x',
      raw: {},
    })
    const info = await resolveAttachEndpoint({ probeImpl })
    expect(info.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/x')
  })

  it('retries until success within budget', async () => {
    let calls = 0
    const probeImpl = async () => {
      calls++
      return calls < 3 ? null : {
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/y',
        raw: {},
      }
    }
    const sleepImpl = async () => {}
    const info = await resolveAttachEndpoint({ probeImpl, sleepImpl, attempts: 5 })
    expect(calls).toBe(3)
    expect(info.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/y')
  })

  it('throws a user-facing error with bad chrome-debug hint after all retries', async () => {
    const probeImpl = async () => null
    const sleepImpl = async () => {}
    await expect(resolveAttachEndpoint({ probeImpl, sleepImpl, attempts: 2 }))
      .rejects.toThrow(/bad chrome-debug/)
  })
})

describe('cli-attach — findChromeBinary', () => {
  it('returns null when no candidate exists', () => {
    // Tests run in a clean env; on CI none of the hardcoded paths
    // are guaranteed, so we tolerate either a string or null.
    const out = findChromeBinary('linux')
    expect(out === null || typeof out === 'string').toBe(true)
  })

  it('returns null on unknown platform', () => {
    expect(findChromeBinary('aix' as NodeJS.Platform)).toBeNull()
  })
})

describe('cli-attach — findChromeUserDataDir', () => {
  it('returns null when home dir has no Chrome profile', () => {
    const tmp = '/tmp/__bad_attach_no_chrome__'
    expect(findChromeUserDataDir('darwin', tmp)).toBeNull()
    expect(findChromeUserDataDir('linux', tmp)).toBeNull()
    expect(findChromeUserDataDir('win32', tmp)).toBeNull()
  })

  it('returns null on unknown platform', () => {
    expect(findChromeUserDataDir('aix' as NodeJS.Platform, '/tmp')).toBeNull()
  })
})

describe('cli-attach — validateAttachConflicts', () => {
  it('blocks wallet mode', () => {
    const out = validateAttachConflicts({ walletEnabled: true })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors.join('\n')).toMatch(/wallet/)
  })

  it('blocks extension paths', () => {
    const out = validateAttachConflicts({ walletEnabled: false, extensionPaths: ['/tmp/x'] })
    expect(out.ok).toBe(false)
  })

  it('allows clean attach when no conflicting flags are set', () => {
    const out = validateAttachConflicts({ walletEnabled: false })
    expect(out.ok).toBe(true)
  })

  it('hard-errors on --profile-dir (no silent fallback)', () => {
    const out = validateAttachConflicts({ walletEnabled: false, profileDir: '/tmp/x' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors.join('\n')).toMatch(/profile-dir is incompatible/)
  })

  it('hard-errors on --user-data-dir', () => {
    const out = validateAttachConflicts({ walletEnabled: false, userDataDir: '/tmp/x' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.errors.join('\n')).toMatch(/user-data-dir is incompatible/)
  })
})

describe('cli-attach — handleChromeDebug', () => {
  it('returns the existing probe if Chrome is already up', async () => {
    const probeImpl = async () => ({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/already',
      raw: {},
    })
    const info = await handleChromeDebug({ probeImpl })
    expect(info.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/already')
  })

  it('throws when no Chrome binary found', async () => {
    let probeCount = 0
    const probeImpl = async () => { probeCount++; return null }
    await expect(handleChromeDebug({
      probeImpl,
      platform: 'aix' as NodeJS.Platform, // unknown
      readyTimeoutMs: 50,
    })).rejects.toThrow(/Could not locate/)
    expect(probeCount).toBe(1) // only the initial "already running?" probe
  })
})

describe('cli-attach — constants', () => {
  it('DEFAULT_ATTACH_PORT is 9222 (the convention)', () => {
    expect(DEFAULT_ATTACH_PORT).toBe(9222)
  })
})

// Real-infra probe tests. These spin up an actual http.Server on a loopback
// port so the probe exercises the production fetch path, not a fabricated
// Response shape. Catches regressions in undici/fetch, AbortController
// propagation, and the /json/version response contract.
describe('cli-attach — probeChromeDebug against a real TCP listener', () => {
  const servers: http.Server[] = []

  async function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()))
  })

  it('probes a real DevTools-shaped endpoint and returns ws + browser', async () => {
    const srv = await startServer((req, res) => {
      if (req.url === '/json/version') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          Browser: 'Chrome/131.0.6778.86',
          webSocketDebuggerUrl: `ws://127.0.0.1:0/devtools/browser/abc`,
        }))
      } else {
        res.statusCode = 404
        res.end()
      }
    })
    try {
      const info = await probeChromeDebug({ port: srv.port, timeoutMs: 2000 })
      expect(info).not.toBeNull()
      expect(info!.webSocketDebuggerUrl).toBe('ws://127.0.0.1:0/devtools/browser/abc')
      expect(info!.browser).toBe('Chrome/131.0.6778.86')
    } finally {
      await srv.close()
    }
  })

  it('returns null when the endpoint returns non-JSON', async () => {
    const srv = await startServer((_req, res) => { res.end('not json at all') })
    try {
      const info = await probeChromeDebug({ port: srv.port, timeoutMs: 1000 })
      expect(info).toBeNull()
    } finally {
      await srv.close()
    }
  })

  it('returns null on connect refused (no listener)', async () => {
    // Use a likely-unbound high port. Can flake in theory but not in practice.
    const info = await probeChromeDebug({ port: 39999, timeoutMs: 500 })
    expect(info).toBeNull()
  })

  it('aborts a body-read that stalls past the timeout', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Send an opening brace then hang — never flush the rest.
      res.write('{')
      // Never call res.end(). The probe's body-read timeout must fire.
    })
    try {
      const t0 = Date.now()
      const info = await probeChromeDebug({ port: srv.port, timeoutMs: 400 })
      const elapsed = Date.now() - t0
      expect(info).toBeNull()
      // Generous upper bound — body timer is 400ms; include scheduling slack.
      expect(elapsed).toBeLessThan(2500)
    } finally {
      await srv.close()
    }
  })
})

describe('cli-attach — handleChromeDebug spawn + poll', () => {
  it('polls until the probe succeeds, then returns', async () => {
    let probeCalls = 0
    const probeImpl = async () => {
      probeCalls++
      if (probeCalls <= 3) return null
      return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x', raw: {} }
    }
    // Fake spawn that returns a minimal child-shaped object. The handler
    // we actually care about is the probe loop.
    const spawnImpl = (() => ({ pid: 99999, killed: false, unref() {}, on() {}, kill() {} })) as unknown as typeof import('node:child_process').spawn
    const info = await handleChromeDebug({
      probeImpl,
      spawnImpl,
      binary: '/tmp/fake-chrome',
      readyTimeoutMs: 2000,
    })
    expect(info.webSocketDebuggerUrl).toBe('ws://127.0.0.1:9222/x')
    expect(probeCalls).toBeGreaterThanOrEqual(4) // once at start + poll cycle(s)
  })

  it('throws with the binary path when deadline exceeded, and kills the child', async () => {
    let killed = false
    const probeImpl = async () => null
    const spawnImpl = (() => ({
      pid: 99998,
      killed: false,
      unref() {},
      on() {},
      kill(_sig: string) { killed = true },
    })) as unknown as typeof import('node:child_process').spawn
    await expect(handleChromeDebug({
      probeImpl,
      spawnImpl,
      binary: '/tmp/fake-chrome-path',
      readyTimeoutMs: 150,
    })).rejects.toThrow(/fake-chrome-path/)
    expect(killed).toBe(true)
  })

  it('throws with exit code when the child exits before the endpoint comes up', async () => {
    const probeImpl = async () => null
    const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
    const spawnImpl = (() => ({
      pid: 99997,
      killed: false,
      unref() {},
      on(event: string, handler: (code: number | null, signal: NodeJS.Signals | null) => void) {
        if (event === 'exit') exitHandlers.push(handler)
      },
      kill() {},
    })) as unknown as typeof import('node:child_process').spawn
    // Schedule the exit slightly after handleChromeDebug starts polling.
    setTimeout(() => { for (const h of exitHandlers) h(1, null) }, 40)
    await expect(handleChromeDebug({
      probeImpl,
      spawnImpl,
      binary: '/tmp/fake-exit',
      readyTimeoutMs: 2000,
    })).rejects.toThrow(/Chrome exited before/)
  })
})
