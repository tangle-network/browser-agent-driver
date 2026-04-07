/**
 * CLI handler for `bad view <run-dir>`.
 *
 * Spins up a tiny static HTTP server in front of the run's artifact
 * directory and opens the viewer in the user's default browser.
 *
 * No build pipeline, no React, no separate package — viewer.html is a
 * single self-contained file shipped in the package and copied to dist
 * at build time by `scripts/copy-static-assets.mjs`.
 *
 * Library-friendly: this module throws typed errors instead of calling
 * `process.exit`. The CLI dispatcher catches and exits.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import chalk from 'chalk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Resolved at module load — single canonical path, no runtime probing. */
const VIEWER_HTML_PATH = (() => {
  // Production: dist/cli-view.js + dist/viewer/viewer.html
  const distPath = path.join(__dirname, 'viewer/viewer.html')
  if (fs.existsSync(distPath)) return distPath
  // Source dev mode: src/cli-view.ts + src/viewer/viewer.html
  const srcPath = path.join(__dirname, '../viewer/viewer.html')
  if (fs.existsSync(srcPath)) return srcPath
  // Last-resort: walking up one more level (for unusual layouts)
  const upPath = path.join(__dirname, '../../src/viewer/viewer.html')
  if (fs.existsSync(upPath)) return upPath
  return ''
})()

export interface ViewOptions {
  /** Run directory containing report.json + screenshots/ */
  runDir: string
  /** Port for the local server. Default 7777. Auto-increments on EADDRINUSE. */
  port?: number
  /** Don't auto-open the browser */
  noOpen?: boolean
  /** Maximum number of consecutive ports to try when EADDRINUSE. Default 10. */
  portRetries?: number
}

export class ViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewError'
  }
}

/**
 * Resolves a `report.json` file inside a run directory. Searches the
 * run directory itself first, then one level deep.
 */
export function findReportJson(runDir: string): string | null {
  const direct = path.join(runDir, 'report.json')
  if (fs.existsSync(direct)) return direct

  try {
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = path.join(runDir, entry.name, 'report.json')
        if (fs.existsSync(sub)) return sub
      }
    }
  } catch {
    /* ignore unreadable dir */
  }
  return null
}

/**
 * Find all recording.webm files anywhere under the report root (one level
 * deep — agent runs put them in `<run>/<test-id>/recording.webm`). Returns
 * an array of `{ testId, relPath }` so the viewer can show one player per
 * test case in a multi-test suite run.
 *
 * Skips 0-byte files (Playwright sometimes writes the path before flushing
 * the video on context close, leaving an empty placeholder) — the viewer
 * will fall back to per-turn screenshots when no usable recording exists.
 */
export function findRecordings(reportRoot: string): Array<{ testId: string; relPath: string }> {
  const out: Array<{ testId: string; relPath: string }> = []
  const isUsableRecording = (filePath: string): boolean => {
    try {
      const stats = fs.statSync(filePath)
      return stats.isFile() && stats.size > 0
    } catch {
      return false
    }
  }
  try {
    for (const entry of fs.readdirSync(reportRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const recording = path.join(reportRoot, entry.name, 'recording.webm')
        if (isUsableRecording(recording)) {
          out.push({ testId: entry.name, relPath: `${entry.name}/recording.webm` })
        }
      } else if (entry.name === 'recording.webm') {
        const recording = path.join(reportRoot, entry.name)
        if (isUsableRecording(recording)) {
          out.push({ testId: 'default', relPath: 'recording.webm' })
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/**
 * Normalize the report shape so the viewer sees a consistent format.
 *
 * Two distinct shapes flow through here:
 *   - **Design audit** (cli-design-audit.ts): top-level `pages[]`, each
 *     with screenshot file paths and findings. Native shape — passed through.
 *   - **Agent run** (test-runner.ts → FilesystemSink): top-level
 *     `results[].agentResult.turns[]` where each turn has `state.screenshot`
 *     as a raw base64 string. Unwrapped to a normalized `{ tests[]: { ...,
 *     turns[] } }` shape with screenshots converted to data URLs.
 *
 * Recordings discovered on disk are attached to the matching test by id.
 */
export function normalizeReport(
  raw: unknown,
  recordings: Array<{ testId: string; relPath: string }>,
): Record<string, unknown> {
  const data = raw as Record<string, unknown>
  if (!data || typeof data !== 'object') return { error: 'invalid report' }

  // Design audit shape — has top-level `pages[]`. Pass through.
  if (Array.isArray((data as { pages?: unknown }).pages)) {
    return data
  }

  // Agent run shape — has top-level `results[]` with `.agentResult.turns[]`.
  if (Array.isArray((data as { results?: unknown }).results)) {
    const results = (data as { results: Array<Record<string, unknown>> }).results
    const tests = results.map(r => {
      const agentResult = (r.agentResult ?? {}) as Record<string, unknown>
      const turns = ((agentResult.turns ?? []) as Array<Record<string, unknown>>).map(t => {
        const state = (t.state ?? {}) as Record<string, unknown>
        const screenshot = state.screenshot as string | undefined
        // Convert raw base64 → data URL so the <img> tag renders it.
        // NOTE: JPEG base64 starts with `/9j/` (first byte 0xFF), so the
        // leading slash is NOT a path indicator. Detect format properly:
        //   - already a data: URL → leave it
        //   - absolute file path or http(s) URL → leave it (legacy on-disk runs)
        //   - everything else → assume base64, prefix as JPEG data URL
        const screenshotDataUrl = !screenshot
          ? screenshot
          : screenshot.startsWith('data:')
            ? screenshot
            : screenshot.startsWith('http://') || screenshot.startsWith('https://')
              ? screenshot
              : screenshot.startsWith('/') && (screenshot.endsWith('.png') || screenshot.endsWith('.jpg') || screenshot.endsWith('.jpeg') || screenshot.endsWith('.webp'))
                ? screenshot
                : `data:image/jpeg;base64,${screenshot}`
        return {
          ...t,
          state: { ...state, screenshot: screenshotDataUrl },
        }
      })
      const testCase = (r.testCase ?? {}) as Record<string, unknown>
      const testId = (testCase.id ?? testCase.name ?? 'cli-task') as string
      const recording = recordings.find(rec => rec.testId === testId)
        ?? recordings.find(rec => rec.testId === 'default')
      return {
        id: testId,
        name: testCase.name ?? testId,
        success: agentResult.success ?? r.agentSuccess,
        verdict: r.verdict,
        turnsUsed: r.turnsUsed,
        durationMs: r.durationMs,
        estimatedCostUsd: r.estimatedCostUsd,
        recording: recording ? recording.relPath : null,
        turns,
      }
    })
    return {
      ...data,
      // Both fields present so existing readers still work; the viewer
      // prefers `tests[]` for agent runs.
      tests,
    }
  }

  // Single agent result shape (no suite wrapper) — `turns[]` directly.
  if (Array.isArray((data as { turns?: unknown }).turns)) {
    const turns = ((data as { turns: Array<Record<string, unknown>> }).turns).map(t => {
      const state = (t.state ?? {}) as Record<string, unknown>
      const screenshot = state.screenshot as string | undefined
      const screenshotDataUrl = !screenshot
        ? screenshot
        : screenshot.startsWith('data:')
          ? screenshot
          : screenshot.startsWith('http://') || screenshot.startsWith('https://')
            ? screenshot
            : screenshot.startsWith('/') && (screenshot.endsWith('.png') || screenshot.endsWith('.jpg') || screenshot.endsWith('.jpeg') || screenshot.endsWith('.webp'))
              ? screenshot
              : `data:image/jpeg;base64,${screenshot}`
      return { ...t, state: { ...state, screenshot: screenshotDataUrl } }
    })
    const recording = recordings.find(rec => rec.testId === 'default') ?? recordings[0]
    return {
      ...data,
      tests: [{
        id: 'default',
        name: 'run',
        recording: recording ? recording.relPath : null,
        turns,
      }],
    }
  }

  return data
}

/**
 * Escape a JSON string for safe inlining inside a `<script>` block.
 *
 * The hazards:
 *   - `</script` (any case): closes the script tag mid-string
 *   - `<!--`: opens an HTML comment, toggles parser modes
 *   - U+2028 / U+2029: legal in JSON, illegal in pre-ES2019 JS string literals
 *
 * Exported for testing.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.map': 'application/json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Best-effort — user can copy the URL from the terminal
  }
}

/**
 * Listen on a port, auto-incrementing on EADDRINUSE up to `maxRetries` times.
 */
async function listenWithRetry(
  server: http.Server,
  startPort: number,
  maxRetries: number,
): Promise<number> {
  for (let i = 0; i <= maxRetries; i++) {
    const port = startPort + i
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return port
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') throw err
      // Try the next port
      continue
    }
  }
  throw new ViewError(
    `could not bind to any port in range ${startPort}–${startPort + maxRetries} (all in use)`,
  )
}

export async function runView(opts: ViewOptions): Promise<{
  url: string
  close: () => Promise<void>
}> {
  const runDir = path.resolve(opts.runDir)
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new ViewError(`run directory not found: ${runDir}`)
  }

  const reportPath = findReportJson(runDir)
  if (!reportPath) {
    throw new ViewError(`no report.json found in ${runDir} or its subdirectories`)
  }

  if (!VIEWER_HTML_PATH) {
    throw new ViewError(
      'viewer.html not found. The package may be missing dist/viewer/viewer.html — try reinstalling.',
    )
  }

  const reportRoot = path.dirname(reportPath)
  const viewerSource = fs.readFileSync(VIEWER_HTML_PATH, 'utf-8')
  const reportRaw = fs.readFileSync(reportPath, 'utf-8')

  // Parse the report, discover any recording.webm files alongside it, and
  // normalize the shape so the viewer sees a consistent format whether
  // this is a design-audit run or an agent suite run.
  let reportObj: unknown
  try {
    reportObj = JSON.parse(reportRaw)
  } catch {
    throw new ViewError(`report.json is not valid JSON: ${reportPath}`)
  }
  const recordings = findRecordings(reportRoot)
  const normalized = normalizeReport(reportObj, recordings)
  const reportJson = JSON.stringify(normalized)
  const safeJson = escapeJsonForScript(reportJson)

  const inlinedHtml = viewerSource.replace(
    'const runData = window.__bad_runData || null;',
    `const runData = ${safeJson};`,
  )

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(inlinedHtml)
      return
    }

    // Path-traversal protection: resolve, check the path stays inside
    // reportRoot via path.relative (startsWith on the prefix is buggy
    // because /tmp/runA-evil shares a prefix with /tmp/runA), and
    // resolve symlinks so they can't escape the sandbox.
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
      // Symlink escaped the sandbox
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!fs.statSync(realPath).isFile()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const ext = path.extname(realPath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(realPath).pipe(res)
  })

  const port = await listenWithRetry(server, opts.port ?? 7777, opts.portRetries ?? 10)
  const url = `http://localhost:${port}`

  console.log('')
  console.log(`  ${chalk.bold('bad view')}`)
  console.log(`  ${chalk.dim('Run:')} ${reportRoot}`)
  console.log(`  ${chalk.dim('URL:')} ${chalk.cyan(url)}`)
  console.log(`  ${chalk.dim('Press Ctrl+C to stop')}`)
  console.log('')

  if (!opts.noOpen) {
    openInBrowser(url)
  }

  const close = () =>
    new Promise<void>(resolve => {
      server.close(() => resolve())
    })

  return { url, close }
}

/**
 * CLI entrypoint that calls runView and keeps the process alive until SIGINT.
 * Throws ViewError on failure — the dispatcher in cli.ts catches and exits.
 */
export async function runViewCli(opts: ViewOptions): Promise<void> {
  const { close } = await runView(opts)

  // Keep alive until SIGINT
  await new Promise<void>(resolve => {
    const onSigint = () => {
      console.log('\n  closing viewer…')
      void close().then(resolve)
    }
    process.once('SIGINT', onSigint)
  })
}
