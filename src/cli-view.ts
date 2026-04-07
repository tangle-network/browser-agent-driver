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

  // Re-parse + re-stringify to normalize and validate the JSON, then escape
  // the standard JSON-in-script hazards before inlining.
  let reportJson: string
  try {
    reportJson = JSON.stringify(JSON.parse(reportRaw))
  } catch {
    throw new ViewError(`report.json is not valid JSON: ${reportPath}`)
  }
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
