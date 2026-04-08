/**
 * Live mode for `bad view` — wraps cli-view.ts with an SSE endpoint that
 * streams TurnEvents from a passed-in TurnEventBus to any subscribed viewer.
 *
 * Architecture:
 *   - The same single-file viewer.html is served. When the URL has `?live=1`
 *     it opens an EventSource on /events and switches to streaming UI.
 *   - The /events endpoint holds the connection open, replays the bus's
 *     buffered history first (so late connectors catch up), then streams
 *     subsequent events as they fire.
 *   - Heartbeat ping every 15s keeps the connection alive across NAT.
 *   - Multiple concurrent viewers are supported (each gets its own
 *     subscription to the bus).
 *   - /cancel POST aborts the run via the supplied AbortController.
 *
 * No external SSE library — Node's native http supports SSE cleanly with
 * just `res.write('data: ...\n\n')`.
 */

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'
import type { TurnEventBus, TurnEvent } from './runner/events.js'
import { serializeForJsonl } from './runner/events.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Resolved at module load — single canonical path. */
const VIEWER_HTML_PATH = (() => {
  const distPath = path.join(__dirname, 'viewer/viewer.html')
  if (fs.existsSync(distPath)) return distPath
  const srcPath = path.join(__dirname, '../viewer/viewer.html')
  if (fs.existsSync(srcPath)) return srcPath
  const upPath = path.join(__dirname, '../../src/viewer/viewer.html')
  if (fs.existsSync(upPath)) return upPath
  return ''
})()

export interface LiveViewOptions {
  /** TurnEventBus the viewer will subscribe to via SSE */
  bus: TurnEventBus
  /** AbortController whose signal is wired to /cancel POSTs */
  cancelController?: AbortController
  /** Port for the local server. Default 7777. */
  port?: number
  /** Don't auto-open the browser */
  noOpen?: boolean
  /** Maximum consecutive ports to try when EADDRINUSE */
  portRetries?: number
}

export interface LiveViewHandle {
  url: string
  close: () => Promise<void>
}

export class LiveViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveViewError'
  }
}

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
  } catch {
    /* best effort */
  }
}

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
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    }
  }
  throw new LiveViewError(
    `could not bind to any port in range ${startPort}-${startPort + maxRetries} (all in use)`,
  )
}

/**
 * Format a TurnEvent for SSE wire transport.
 *
 *   event: <type>
 *   id: <seq>
 *   data: <json>
 *   <blank line>
 *
 * EventSource auto-reconnects with the last seen `id` in the
 * Last-Event-ID header so server-side replay can be resumed.
 */
export function formatSseEvent(event: TurnEvent): string {
  const data = serializeForJsonl(event)
  return `event: ${event.type}\nid: ${event.seq}\ndata: ${data}\n\n`
}

/**
 * Spin up the live view server.
 *
 *   GET /                — serves viewer.html with `?live=1` injected
 *   GET /events          — SSE stream of TurnEvents
 *   POST /cancel         — sends abort signal to the run
 *   GET /<file>          — static asset under the viewer subtree
 */
export async function runLiveView(opts: LiveViewOptions): Promise<LiveViewHandle> {
  if (!VIEWER_HTML_PATH) {
    throw new LiveViewError(
      'viewer.html not found. The package may be missing dist/viewer/viewer.html — try reinstalling.',
    )
  }
  const viewerSource = fs.readFileSync(VIEWER_HTML_PATH, 'utf-8')

  // The live page injects ?live=1 into the existing viewer HTML and exposes
  // a global flag that the viewer's bootstrap script reads. The static replay
  // path is left intact: when no events are streamed, the viewer falls back
  // to its existing window.__bad_runData reading. Live mode just appends a
  // small bootstrap that opens an EventSource and re-renders on each event.
  const liveBootstrap = `
<script>
(() => {
  window.__bad_live = true;
  const events = [];
  const subscribers = new Set();
  window.__bad_subscribeEvents = (fn) => {
    subscribers.add(fn);
    for (const e of events) fn(e);
    return () => subscribers.delete(fn);
  };
  window.__bad_cancelRun = async () => {
    try { await fetch('/cancel', { method: 'POST' }); } catch {}
  };
  const es = new EventSource('/events');
  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      events.push(event);
      for (const fn of subscribers) fn(event);
    } catch {}
  };
  es.onerror = () => {
    // EventSource auto-reconnects via Last-Event-ID; nothing to do.
  };
})();
</script>
`
  const liveHtml = viewerSource.replace('</body>', `${liveBootstrap}</body>`)

  const server = http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]

    if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(liveHtml)
      return
    }

    if (req.method === 'GET' && urlPath === '/events') {
      // SSE handshake
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering if behind proxy
      })
      // Initial comment so EventSource considers the connection open
      res.write(': bad live stream\n\n')

      // Subscribe with replay so the viewer catches up to current state
      const unsub = opts.bus.subscribe((event: TurnEvent) => {
        try {
          res.write(formatSseEvent(event))
        } catch {
          // Connection closed mid-write — unsubscribe and stop
          unsub()
        }
      }, true)

      // Heartbeat to keep the connection alive across NATs / proxies
      const heartbeat = setInterval(() => {
        try {
          res.write(': heartbeat\n\n')
        } catch {
          // ignore
        }
      }, 15_000)

      req.on('close', () => {
        clearInterval(heartbeat)
        unsub()
      })
      return
    }

    if (req.method === 'POST' && urlPath === '/cancel') {
      if (opts.cancelController) {
        opts.cancelController.abort('cancelled by user via live viewer')
      }
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cancelled: true }))
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  const port = await listenWithRetry(server, opts.port ?? 7777, opts.portRetries ?? 10)
  // Use 127.0.0.1 explicitly so the URL matches the bind address. Linux
  // runners can resolve "localhost" to ::1 (IPv6) first, which fails to
  // connect because the server only listens on the IPv4 loopback.
  const url = `http://127.0.0.1:${port}`

  console.log('')
  console.log(`  ${chalk.bold('bad live')}`)
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
