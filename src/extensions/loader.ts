/**
 * Extension loader — discovers and loads `bad.config.{js,mjs,ts}` from the
 * cwd, plus any explicit paths passed via `--extension`.
 *
 * Loading is done via dynamic import so the cost is paid only when an
 * extension is actually present. Failures are surfaced to stderr but never
 * crash bad — a broken user config should be reportable, not fatal.
 */

import * as path from 'node:path'
import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isBadExtension, resolveExtensions, type BadExtension, type ResolvedExtensions } from './types.js'

const AUTO_DISCOVERY_NAMES = [
  'bad.config.ts',
  'bad.config.mts',
  'bad.config.mjs',
  'bad.config.js',
  'bad.config.cjs',
] as const

export interface LoadExtensionsOptions {
  /** Working directory to search for bad.config.* files. Defaults to cwd. */
  cwd?: string
  /** Explicit extension file paths from --extension flags. */
  explicitPaths?: string[]
  /** Skip auto-discovery (only load explicit paths). */
  skipAutoDiscovery?: boolean
  /** Logger for load errors. Defaults to stderr. */
  onError?: (path: string, err: unknown) => void
}

export interface LoadResult {
  /** The resolved extension bundle, ready for the runner. */
  resolved: ResolvedExtensions
  /** Paths of extensions that were loaded successfully. */
  loadedFrom: string[]
  /** Paths of extensions that failed to load (with errors). */
  errors: Array<{ path: string; error: string }>
}

/**
 * Discover and load all extensions for this run. Auto-discovers
 * bad.config.{ts,mjs,js,...} from `cwd` and merges with any explicit
 * --extension paths.
 *
 * Returns a single resolved bundle even when no extensions are found —
 * callers always get back a usable object (no-op fanout, empty rules).
 */
export async function loadExtensions(options: LoadExtensionsOptions = {}): Promise<LoadResult> {
  const cwd = options.cwd ?? process.cwd()
  const explicitPaths = options.explicitPaths ?? []
  const onError = options.onError ?? ((p, err) => {
    // eslint-disable-next-line no-console
    console.error(`[bad-extension] failed to load ${p}: ${err instanceof Error ? err.message : String(err)}`)
  })

  const candidates: string[] = []

  // Auto-discovered files (first match wins — bad.config.ts > .mjs > .js)
  if (!options.skipAutoDiscovery) {
    for (const name of AUTO_DISCOVERY_NAMES) {
      const candidate = path.join(cwd, name)
      if (fs.existsSync(candidate)) {
        candidates.push(candidate)
        break // only the first auto-discovered config
      }
    }
  }

  // Explicit paths from --extension flags (always loaded after auto-discovery)
  for (const explicit of explicitPaths) {
    const resolved = path.isAbsolute(explicit)
      ? explicit
      : path.resolve(cwd, explicit)
    if (!fs.existsSync(resolved)) {
      onError(resolved, new Error('file not found'))
      continue
    }
    candidates.push(resolved)
  }

  const loaded: BadExtension[] = []
  const loadedFrom: string[] = []
  const errors: Array<{ path: string; error: string }> = []

  for (const candidate of candidates) {
    try {
      // Use file URL so dynamic import works on absolute paths cross-platform
      // (Windows doesn't accept bare absolute paths via import()).
      const url = pathToFileURL(candidate).href
      const mod = await import(url)
      const ext = (mod.default ?? mod) as unknown
      if (!isBadExtension(ext)) {
        throw new Error('export default does not match BadExtension shape')
      }
      loaded.push(ext)
      loadedFrom.push(candidate)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ path: candidate, error: message })
      onError(candidate, err)
    }
  }

  return {
    resolved: resolveExtensions(loaded),
    loadedFrom,
    errors,
  }
}
