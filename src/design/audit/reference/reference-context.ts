/**
 * Reference resolution adapter — turn the operator's `--reference <url|path>`
 * into a resolved `ReferenceContext` ONCE, fail-closed.
 *
 * It owns the SINGLE IO seam (a live URL or a ripped local copy → `DesignDNA`)
 * by delegating to an injected `DesignDnaExtractor`; it adds zero extraction
 * logic of its own and the DNA→summary fold reuses the pure `summarizeDNA`, so
 * it unit-tests against a deterministic fake extractor with no live browser or
 * network. Per ARCHITECTURE §9 D3 it lives in its own small module — not the fat
 * orchestrator — so both the CLI plumbing and tests reach it directly.
 *
 * Fail-closed: an unresolvable reference throws an explicit error rather than
 * degrading to a fabricated "neutral" reference that would silently mis-ground.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DesignDnaExtractor, ReferenceContext, ReferenceKind } from './contracts.js'
import { summarizeDNA } from './dna/derive.js'

/** The single dependency the resolver injects — the page→DNA extractor seam. */
export interface ResolveReferenceDeps {
  extractor: DesignDnaExtractor
}

/** Browser/IO knobs forwarded to the extractor for the reference capture. */
export interface ResolveReferenceOptions {
  headless?: boolean
  outputDir?: string
}

const HTTP_RE = /^https?:\/\//i

/**
 * Classify a `--reference` argument into a `ReferenceKind` and the URL the
 * extractor consumes. A live `http(s)` ref is a `url`; any other value is a
 * `rip` (a previously ripped local copy) addressed as a `file://` URL so the
 * same extractor handles both. A relative path is resolved against the cwd.
 */
function classifyReference(ref: string): { kind: ReferenceKind; url: string } {
  if (HTTP_RE.test(ref)) return { kind: 'url', url: ref }
  if (ref.startsWith('file://')) return { kind: 'rip', url: ref }
  const abs = path.isAbsolute(ref) ? ref : path.resolve(ref)
  return { kind: 'rip', url: pathToFileURL(abs).href }
}

/** Prefer the desktop capture; otherwise any captured viewport, else none. */
function firstScreenshot(paths: Record<string, string>): string | undefined {
  return paths['desktop'] ?? Object.values(paths)[0]
}

/**
 * Resolve `--reference` into a `ReferenceContext` exactly once. Returns
 * `undefined` when no reference was supplied (the engine then grounds against
 * the corpus alone); throws when a supplied reference cannot be captured.
 */
export async function resolveReferenceContext(
  ref: string | undefined,
  deps: ResolveReferenceDeps,
  opts: ResolveReferenceOptions = {},
): Promise<ReferenceContext | undefined> {
  if (!ref) return undefined
  const { kind, url } = classifyReference(ref)
  let capture
  try {
    capture = await deps.extractor.extract({
      url,
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
      ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
    })
  } catch (err) {
    throw new Error(`--reference could not be resolved (${ref}): ${(err as Error).message}`)
  }
  const screenshotPath = firstScreenshot(capture.screenshotPaths)
  return {
    kind,
    dna: capture.dna,
    summary: summarizeDNA(capture.dna),
    ...(screenshotPath ? { screenshotPath } : {}),
  }
}
