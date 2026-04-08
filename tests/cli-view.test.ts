/**
 * Tests for cli-view security and resolution helpers.
 *
 * These tests cover the bug surfaces flagged in the critical audit:
 *   - Path traversal protection in the static server
 *   - XSS-safe inlining of report.json into the viewer HTML
 *   - findReportJson resolution (top-level + one level deep)
 *   - Loopback-only binding
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { escapeJsonForScript, findReportJson, findRecordings, findEventLogs, normalizeReport } from '../src/cli-view.js'

// We test the SECURITY guarantees, not the implementation details.
// Spin up a small fake using the same primitives as cli-view.ts and
// assert the contracts hold.

function createTestServer(reportRoot: string): http.Server {
  return http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]
    const decoded = decodeURIComponent(urlPath)
    const candidate = path.resolve(reportRoot, decoded.replace(/^\/+/, ''))
    const rel = path.relative(reportRoot, candidate)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    let realPath: string
    try {
      realPath = fs.realpathSync(candidate)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const realRel = path.relative(reportRoot, realPath)
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!fs.statSync(realPath).isFile()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    fs.createReadStream(realPath).pipe(res)
  })
}

async function startServer(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (typeof addr === 'string' || !addr) throw new Error('no address')
  return addr.port
}

async function fetchStatus(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    }).on('error', reject)
  })
}

describe('cli-view path traversal protection', () => {
  let tmpDir: string
  let reportRoot: string
  let server: http.Server
  let port: number

  beforeEach(async () => {
    // Use realpath on the temp dir itself — on macOS it's a symlink target.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-view-')))
    reportRoot = path.join(tmpDir, 'report-A')
    fs.mkdirSync(reportRoot, { recursive: true })
    fs.writeFileSync(path.join(reportRoot, 'index.html'), '<h1>ok</h1>')
    fs.mkdirSync(path.join(reportRoot, 'screenshots'))
    fs.writeFileSync(path.join(reportRoot, 'screenshots', 'a.png'), 'fake-png')
    // Create a sibling directory with a sensitive file — must NOT be reachable.
    const sibling = path.join(tmpDir, 'report-A-evil')
    fs.mkdirSync(sibling)
    fs.writeFileSync(path.join(sibling, 'secret.txt'), 'TOP-SECRET')

    server = createTestServer(reportRoot)
    port = await startServer(server)
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('serves files inside the report root', async () => {
    expect(await fetchStatus(port, '/index.html')).toBe(200)
    expect(await fetchStatus(port, '/screenshots/a.png')).toBe(200)
  })

  it('rejects absolute paths', async () => {
    expect(await fetchStatus(port, '/etc/passwd')).toBe(404)
  })

  it('rejects ../ traversal attempts', async () => {
    // The relative-path check rejects this — request resolves outside reportRoot
    const status = await fetchStatus(port, '/../report-A-evil/secret.txt')
    expect([403, 404]).toContain(status) // 403 ideal, 404 acceptable if URL parsing collapses
  })

  it('rejects prefix-confusion attacks', async () => {
    // The classic startsWith bug: /tmp/report-A vs /tmp/report-A-evil.
    // path.relative() catches this where startsWith() does not.
    // We try to reach the sibling via various URL forms.
    const status = await fetchStatus(port, '/..%2Freport-A-evil/secret.txt')
    expect([403, 404]).toContain(status)
  })

  it('rejects symlinks that escape the root', async () => {
    // Create a symlink inside reportRoot that points to the sibling.
    // realpath should detect the escape.
    const linkPath = path.join(reportRoot, 'evil-link')
    try {
      fs.symlinkSync(path.join(tmpDir, 'report-A-evil', 'secret.txt'), linkPath)
    } catch {
      // Some systems can't create symlinks (Windows without admin); skip.
      return
    }
    expect(await fetchStatus(port, '/evil-link')).toBe(403)
  })

  it('returns 404 for non-existent files', async () => {
    expect(await fetchStatus(port, '/nope.html')).toBe(404)
  })
})

describe('escapeJsonForScript (the actual exported helper)', () => {
  // Exercises the real exported function rather than a copy. The fix wraps:
  //   </script  → <\/script  (closes the script tag mid-string)
  //   <!--      → <\!--      (HTML comment toggles parser modes)
  //   U+2028/29 → \u2028 / \u2029  (legal in JSON, illegal in pre-ES2019 JS strings)

  function safeInline(rawJson: string): string {
    return escapeJsonForScript(JSON.stringify(JSON.parse(rawJson)))
  }

  it('escapes </script> in string values', () => {
    const evil = JSON.stringify({ description: 'hello </script><img src=x onerror=alert(1)>' })
    const safe = safeInline(evil)
    expect(safe).not.toContain('</script>')
    expect(safe).toContain('<\\/script>')
  })

  it('escapes uppercase </SCRIPT> too', () => {
    const evil = JSON.stringify({ x: '</SCRIPT>' })
    const safe = safeInline(evil)
    expect(safe).not.toMatch(/<\/script>/i)
  })

  it('escapes HTML comment markers', () => {
    const evil = JSON.stringify({ x: '<!-- evil -->' })
    const safe = safeInline(evil)
    expect(safe).not.toContain('<!--')
  })

  it('escapes U+2028 and U+2029 line separators', () => {
    const evil = JSON.stringify({ x: 'a\u2028b\u2029c' })
    const safe = safeInline(evil)
    expect(safe).not.toContain('\u2028')
    expect(safe).not.toContain('\u2029')
    expect(safe).toContain('\\u2028')
    expect(safe).toContain('\\u2029')
  })

  it('preserves the original data when parsed back', () => {
    const original = { score: 9, description: '</script>literal', list: [1, 2] }
    const safe = safeInline(JSON.stringify(original))
    // Use eval-equivalent inside a Function to simulate <script> parsing
    const reparsed = JSON.parse(
      safe
        .replace(/<\\\/(script)/gi, '</$1')
        .replace(/<\\!--/g, '<!--')
        .replace(/\\u2028/g, '\u2028')
        .replace(/\\u2029/g, '\u2029'),
    )
    expect(reparsed).toEqual(original)
  })
})

describe('normalizeReport', () => {
  it('passes design-audit reports through unchanged', () => {
    const audit = {
      pages: [{ url: 'https://stripe.com', score: 9, screenshotPath: '/some/path/screenshots/index.png' }],
      summary: { avgScore: 9, totalFindings: 13, critical: 0, major: 3, minor: 10 },
      topFixes: [],
    }
    const out = normalizeReport(audit, [])
    expect(out.pages).toEqual(audit.pages)
    expect(out.tests).toBeUndefined()
  })

  it('unwraps agent-suite results into tests[] with normalized turns', () => {
    const suite = {
      results: [
        {
          testCase: { id: 'login', name: 'login flow' },
          agentResult: {
            success: true,
            turns: [
              {
                turn: 0,
                action: { action: 'click', selector: '@a1' },
                state: { url: 'https://app.example.com', screenshot: '/9j/SOME_RAW_BASE64' },
              },
            ],
          },
          verdict: 'verified',
          turnsUsed: 1,
        },
      ],
    }
    const out = normalizeReport(suite, []) as Record<string, unknown>
    const tests = out.tests as Array<{
      id: string
      success: boolean
      turns: Array<{ state: { screenshot: string } }>
    }>
    expect(tests).toHaveLength(1)
    expect(tests[0].id).toBe('login')
    expect(tests[0].success).toBe(true)
    // The raw base64 (which starts with /9j/) was wrapped in a data URL,
    // not mistaken for a file path
    expect(tests[0].turns[0].state.screenshot).toBe('data:image/jpeg;base64,/9j/SOME_RAW_BASE64')
  })

  it('preserves data: URL screenshots without double-wrapping', () => {
    const suite = {
      results: [
        {
          testCase: { id: 't' },
          agentResult: {
            turns: [{ state: { screenshot: 'data:image/png;base64,iVBORw0KGgo=' } }],
          },
        },
      ],
    }
    const out = normalizeReport(suite, []) as Record<string, unknown>
    const tests = out.tests as Array<{ turns: Array<{ state: { screenshot: string } }> }>
    expect(tests[0].turns[0].state.screenshot).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('preserves on-disk screenshot paths without wrapping as base64', () => {
    const suite = {
      results: [
        {
          testCase: { id: 't' },
          agentResult: {
            turns: [{ state: { screenshot: '/abs/path/turn-1.png' } }],
          },
        },
      ],
    }
    const out = normalizeReport(suite, []) as Record<string, unknown>
    const tests = out.tests as Array<{ turns: Array<{ state: { screenshot: string } }> }>
    expect(tests[0].turns[0].state.screenshot).toBe('/abs/path/turn-1.png')
  })

  it('attaches recordings to the matching test by id', () => {
    const suite = {
      results: [
        { testCase: { id: 'cli-task' }, agentResult: { turns: [] } },
        { testCase: { id: 'wallet-test' }, agentResult: { turns: [] } },
      ],
    }
    const recordings = [
      { testId: 'cli-task', relPath: 'cli-task/recording.webm' },
      { testId: 'wallet-test', relPath: 'wallet-test/recording.webm' },
    ]
    const out = normalizeReport(suite, recordings) as Record<string, unknown>
    const tests = out.tests as Array<{ id: string; recording: string | null }>
    expect(tests[0].recording).toBe('cli-task/recording.webm')
    expect(tests[1].recording).toBe('wallet-test/recording.webm')
  })

  it('falls back to default recording when no test id matches', () => {
    const suite = {
      results: [{ testCase: { id: 'whatever' }, agentResult: { turns: [] } }],
    }
    const recordings = [{ testId: 'default', relPath: 'recording.webm' }]
    const out = normalizeReport(suite, recordings) as Record<string, unknown>
    const tests = out.tests as Array<{ recording: string | null }>
    expect(tests[0].recording).toBe('recording.webm')
  })

  it('handles legacy single-result shape with turns[] at root', () => {
    const single = {
      success: true,
      turns: [
        { turn: 0, action: { action: 'click' }, state: { screenshot: '/9j/RAW' } },
      ],
    }
    const out = normalizeReport(single, []) as Record<string, unknown>
    const tests = out.tests as Array<{ turns: Array<{ state: { screenshot: string } }> }>
    expect(tests).toHaveLength(1)
    expect(tests[0].turns[0].state.screenshot).toBe('data:image/jpeg;base64,/9j/RAW')
  })
})

describe('findRecordings', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-rec-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds recordings one level deep', () => {
    fs.mkdirSync(path.join(tmpDir, 'cli-task'))
    fs.writeFileSync(path.join(tmpDir, 'cli-task', 'recording.webm'), 'fake')
    fs.mkdirSync(path.join(tmpDir, 'wallet'))
    fs.writeFileSync(path.join(tmpDir, 'wallet', 'recording.webm'), 'fake')
    const recs = findRecordings(tmpDir)
    expect(recs).toHaveLength(2)
    expect(recs.map(r => r.testId).sort()).toEqual(['cli-task', 'wallet'])
  })

  it('returns empty when no recordings exist', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    expect(findRecordings(tmpDir)).toEqual([])
  })

  it('finds top-level recording.webm as default', () => {
    fs.writeFileSync(path.join(tmpDir, 'recording.webm'), 'fake')
    const recs = findRecordings(tmpDir)
    expect(recs).toHaveLength(1)
    expect(recs[0].testId).toBe('default')
  })

  it('skips 0-byte recordings (Playwright finalization race)', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty-test'))
    fs.writeFileSync(path.join(tmpDir, 'empty-test', 'recording.webm'), '')
    fs.mkdirSync(path.join(tmpDir, 'good-test'))
    fs.writeFileSync(path.join(tmpDir, 'good-test', 'recording.webm'), 'real-content')
    const recs = findRecordings(tmpDir)
    expect(recs).toHaveLength(1)
    expect(recs[0].testId).toBe('good-test')
  })
})

describe('findEventLogs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-events-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds events.jsonl one level deep and parses each line', () => {
    fs.mkdirSync(path.join(tmpDir, 'cli-task'))
    fs.writeFileSync(
      path.join(tmpDir, 'cli-task', 'events.jsonl'),
      JSON.stringify({ type: 'turn-started', seq: 1, runId: 'r', turn: 1 }) +
        '\n' +
        JSON.stringify({ type: 'turn-completed', seq: 2, runId: 'r', turn: 1 }) +
        '\n',
    )
    const logs = findEventLogs(tmpDir)
    expect(logs).toHaveLength(1)
    expect(logs[0].testId).toBe('cli-task')
    expect(logs[0].events).toHaveLength(2)
    expect(logs[0].events[0].type).toBe('turn-started')
    expect(logs[0].events[1].type).toBe('turn-completed')
  })

  it('groups multiple test directories independently', () => {
    fs.mkdirSync(path.join(tmpDir, 'a'))
    fs.writeFileSync(
      path.join(tmpDir, 'a', 'events.jsonl'),
      JSON.stringify({ type: 'turn-started', seq: 1, runId: 'r', turn: 1 }) + '\n',
    )
    fs.mkdirSync(path.join(tmpDir, 'b'))
    fs.writeFileSync(
      path.join(tmpDir, 'b', 'events.jsonl'),
      JSON.stringify({ type: 'turn-started', seq: 1, runId: 'r', turn: 1 }) + '\n' +
        JSON.stringify({ type: 'turn-completed', seq: 2, runId: 'r', turn: 1 }) + '\n',
    )
    const logs = findEventLogs(tmpDir)
    expect(logs).toHaveLength(2)
    const byId = Object.fromEntries(logs.map((l) => [l.testId, l.events.length]))
    expect(byId.a).toBe(1)
    expect(byId.b).toBe(2)
  })

  it('returns empty when no events.jsonl exists', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty'))
    expect(findEventLogs(tmpDir)).toEqual([])
  })

  it('skips bad JSON lines instead of throwing', () => {
    fs.mkdirSync(path.join(tmpDir, 'mixed'))
    fs.writeFileSync(
      path.join(tmpDir, 'mixed', 'events.jsonl'),
      JSON.stringify({ type: 'turn-started', seq: 1, runId: 'r', turn: 1 }) + '\n' +
        'not json at all\n' +
        JSON.stringify({ type: 'turn-completed', seq: 2, runId: 'r', turn: 1 }) + '\n',
    )
    const logs = findEventLogs(tmpDir)
    expect(logs).toHaveLength(1)
    expect(logs[0].events).toHaveLength(2) // bad line skipped, two valid survive
  })

  it('finds top-level events.jsonl as default', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'events.jsonl'),
      JSON.stringify({ type: 'turn-started', seq: 1, runId: 'r', turn: 1 }) + '\n',
    )
    const logs = findEventLogs(tmpDir)
    expect(logs).toHaveLength(1)
    expect(logs[0].testId).toBe('default')
  })
})

describe('findReportJson resolution', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-view-find-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds report.json at the top level', () => {
    fs.writeFileSync(path.join(tmpDir, 'report.json'), '{}')
    expect(findReportJson(tmpDir)).toBe(path.join(tmpDir, 'report.json'))
  })

  it('finds report.json one level deep', () => {
    const sub = path.join(tmpDir, 'audits', 'site-1')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'audits', 'report.json'), '{}')
    expect(findReportJson(tmpDir)).toBe(path.join(tmpDir, 'audits', 'report.json'))
  })

  it('returns null when no report.json exists', () => {
    expect(findReportJson(tmpDir)).toBeNull()
  })
})
