/**
 * CLI handler for `bad view <run-dir>`.
 *
 * Spins up a tiny static HTTP server in front of the run's artifact
 * directory and opens the viewer in the user's default browser.
 *
 * No build pipeline, no React, no separate package — viewer.html is a
 * single self-contained file shipped in the package and copied to dist
 * at build time.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as http from 'node:http'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { cliError } from './cli-ui.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface ViewOptions {
  /** Run directory containing report.json + screenshots/ */
  runDir: string
  /** Port for the local server (default 7777) */
  port?: number
  /** Don't auto-open the browser */
  noOpen?: boolean
}

function findReportJson(runDir: string): string | null {
  // Common layouts: <runDir>/report.json or <runDir>/<sub>/report.json
  const direct = path.join(runDir, 'report.json')
  if (fs.existsSync(direct)) return direct

  // Search one level deep
  try {
    for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const sub = path.join(runDir, entry.name, 'report.json')
        if (fs.existsSync(sub)) return sub
      }
    }
  } catch { /* ignore */ }
  return null
}

function findViewerHtml(): string {
  // The CLI runs from dist/, the viewer is at dist/viewer/viewer.html.
  // Walk up to find it (works in both src and dist layouts).
  const candidates = [
    path.join(__dirname, 'viewer/viewer.html'),
    path.join(__dirname, '../src/viewer/viewer.html'),
    path.join(__dirname, '../viewer/viewer.html'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('viewer.html not found in dist/ or src/')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'application/javascript',
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

export async function runView(opts: ViewOptions): Promise<void> {
  const runDir = path.resolve(opts.runDir)
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    cliError(`run directory not found: ${runDir}`)
    process.exit(1)
  }

  const reportPath = findReportJson(runDir)
  if (!reportPath) {
    cliError(`no report.json found in ${runDir} or its subdirectories`)
    process.exit(1)
  }

  const reportRoot = path.dirname(reportPath)
  const viewerHtml = findViewerHtml()
  const viewerSource = fs.readFileSync(viewerHtml, 'utf-8')
  const reportJson = fs.readFileSync(reportPath, 'utf-8')

  // Inline the report data into the HTML so the viewer doesn't need to
  // fetch (avoids CORS in some environments).
  const inlinedHtml = viewerSource.replace(
    'const runData = window.__BAD_RUN_DATA || null;',
    `const runData = ${reportJson};`,
  )

  const port = opts.port ?? 7777
  const server = http.createServer((req, res) => {
    let urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(inlinedHtml)
      return
    }

    // Serve files from the report directory (screenshots, etc.)
    const decoded = decodeURIComponent(urlPath)
    // Prevent path traversal
    const safePath = path.join(reportRoot, decoded.replace(/^\/+/, ''))
    if (!safePath.startsWith(reportRoot)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const ext = path.extname(safePath).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(safePath).pipe(res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })

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

  // Keep the process alive until the user kills it
  process.on('SIGINT', () => {
    console.log('\n  closing viewer…')
    server.close(() => process.exit(0))
  })
}
