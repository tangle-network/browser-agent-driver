/**
 * `bad share <run-id>` — create a bad-app share link from a completed
 * run and copy the URL to the system clipboard.
 *
 * The whole command exists to collapse five clicks into one:
 *   1. Open the bad-app UI
 *   2. Find the run
 *   3. Click Share
 *   4. Copy URL
 *   5. Paste into Slack / Linear / email
 *
 * Now: `bad share <run-id>` → URL on stdout + clipboard.
 *
 * Library-friendly: throws `ShareError` instead of calling process.exit.
 * Clipboard write is best-effort — we print the URL regardless so the
 * command works over SSH and in CI.
 */

import { spawn } from 'node:child_process'
import chalk from 'chalk'

export class ShareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShareError'
  }
}

export interface ShareOptions {
  /** Run ID from `bad runs` (e.g., "run_1710543210_abc"). */
  runId: string
  /**
   * Visibility tier for the share link. Defaults to 'metadata' — the safest
   * tier that still shows run summary (goal, cost, turns, verdict). Use
   * 'full' for demo links that need per-step reasoning. Use 'artifacts'
   * for competitive-research material where reasoning is proprietary.
   */
  visibility?: 'artifacts' | 'metadata' | 'full'
  /**
   * bad-app base URL. Defaults to env BAD_APP_BASE_URL or
   * https://browser.tangle.tools. Override for staging / local dev.
   */
  baseUrl?: string
  /**
   * API key (bad_sk_...) used to authenticate POST /api/ci/share-links.
   * Falls back to env BAD_APP_API_KEY. Not required in every deployment
   * — some setups expose a cookie-authenticated share endpoint; this
   * command uses the CI API surface which requires a key.
   */
  apiKey?: string
  /** Skip clipboard copy. Default: false (we try to copy). */
  noCopy?: boolean
  /** Emit URL only on stdout (no color, no prefix). Good for piping. */
  json?: boolean
}

export interface ShareResult {
  id: string
  url: string
  expiresAt: string
  visibility: string
  copiedToClipboard: boolean
}

const DEFAULT_BASE_URL = 'https://browser.tangle.tools'

/**
 * Copy to the macOS clipboard via pbcopy. On Linux falls back to xclip /
 * xsel if available. On Windows falls back to clip.exe. All best-effort
 * — a missing tool is a warning, not a fatal.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: { cmd: string; args: string[] }[] = [
    { cmd: 'pbcopy', args: [] }, // macOS
    { cmd: 'wl-copy', args: [] }, // Wayland
    { cmd: 'xclip', args: ['-selection', 'clipboard'] }, // X11
    { cmd: 'xsel', args: ['--clipboard', '--input'] }, // X11 fallback
    { cmd: 'clip.exe', args: [] }, // Windows / WSL
  ]
  for (const c of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const p = spawn(c.cmd, c.args, { stdio: ['pipe', 'ignore', 'ignore'] })
        p.on('error', () => resolve(false))
        p.on('close', (code) => resolve(code === 0))
        p.stdin.write(text)
        p.stdin.end()
      } catch { resolve(false) }
    })
    if (ok) return true
  }
  return false
}

/**
 * Create a share link via the bad-app CI API. Returns the parsed response
 * (id, url, expiresAt, visibility). Throws `ShareError` on any failure.
 *
 * This uses POST /api/ci/share-links — an endpoint that MAY not exist in
 * every bad-app deployment yet. When absent we fall through to
 * POST /api/share with a session cookie if one is available via
 * `~/.bad/session` (left for a future cookie-flow). For now the command
 * requires a CI API key.
 */
export async function createShareLink(opts: ShareOptions): Promise<{
  id: string
  url: string
  expiresAt: string
  visibility: string
}> {
  const baseUrl = (opts.baseUrl || process.env.BAD_APP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const apiKey = opts.apiKey || process.env.BAD_APP_API_KEY
  if (!apiKey) {
    throw new ShareError(
      'bad-app API key required. Set BAD_APP_API_KEY or pass --api-key <bad_sk_...>.\n' +
      `  Create one at: ${baseUrl}/settings/api-keys`,
    )
  }
  const visibility = opts.visibility || 'metadata'
  const endpoint = `${baseUrl}/api/ci/share-links`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ runId: opts.runId, visibility }),
  }).catch((err: Error) => {
    throw new ShareError(`Network error: ${err.message}`)
  })

  if (res.status === 404) {
    throw new ShareError(
      `Run not found: ${opts.runId}\n` +
      `  The run may belong to another workspace, be expired, or not exist.\n` +
      `  Verify with: bad runs`,
    )
  }
  if (res.status === 401 || res.status === 403) {
    throw new ShareError(
      `API key rejected (${res.status}). Verify the key at ${baseUrl}/settings/api-keys`,
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new ShareError(`Share link creation failed (${res.status}): ${body.slice(0, 200)}`)
  }

  const payload = await res.json().catch(() => {
    throw new ShareError('Share link endpoint returned non-JSON response')
  }) as { id?: string; url?: string; expiresAt?: string; visibility?: string }

  if (!payload.id || !payload.url) {
    throw new ShareError(`Malformed share-link response: ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return {
    id: payload.id,
    url: payload.url,
    expiresAt: payload.expiresAt ?? '',
    visibility: payload.visibility ?? visibility,
  }
}

/**
 * Top-level `bad share` command handler. Prints the share URL, attempts
 * to copy it to the clipboard, and returns the result so callers can
 * pipe it further.
 */
export async function handleShareCommand(opts: ShareOptions): Promise<ShareResult> {
  const link = await createShareLink(opts)
  let copied = false
  if (!opts.noCopy) {
    copied = await copyToClipboard(link.url)
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...link, copiedToClipboard: copied }, null, 2))
  } else {
    console.log('')
    console.log(`  ${chalk.green('✓')} Share link created`)
    console.log(`  ${chalk.bold(link.url)}`)
    const tail: string[] = []
    tail.push(chalk.dim(`visibility: ${link.visibility}`))
    if (link.expiresAt) tail.push(chalk.dim(`expires ${link.expiresAt}`))
    if (copied) tail.push(chalk.dim('(copied to clipboard)'))
    console.log(`  ${tail.join(chalk.dim(' · '))}`)
    console.log('')
  }

  return { ...link, copiedToClipboard: copied }
}
