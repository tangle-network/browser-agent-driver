/**
 * Page→DNA extraction adapter — the thin IO boundary over the pure `toDesignDNA`
 * core. Implements the `DesignDnaExtractor` contract.
 *
 * Reuse, not reimplementation: the raw DOM walk (`extractTokensFromDOM`), the
 * multi-viewport merge, colour clustering and grid detection all already live in
 * `extractDesignTokens` (`design/audit/tokens/extract.ts`, a leaf). This adapter
 * calls that one exported function and hands its `DesignTokens` to `toDesignDNA`
 * — it owns zero extraction logic of its own.
 *
 * The reach into the tokens leaf is a LAZY `await import` (mirroring `compare.ts`)
 * so the engine takes no static dependency on the browser-heavy extractor; the
 * pure cores never touch it.
 */

import type { DesignDnaExtractor, DnaCapture, ExtractPageDnaOptions } from '../contracts.js'
import { toDesignDNA } from './derive.js'

export function createPageDnaExtractor(): DesignDnaExtractor {
  return {
    async extract(opts: ExtractPageDnaOptions): Promise<DnaCapture> {
      const { extractDesignTokens } = await import('../../tokens/extract.js')
      const { tokens, outputDir, screenshotPaths, scrollMotion } = await extractDesignTokens({
        url: opts.url,
        headless: opts.headless,
        outputDir: opts.outputDir,
        captureScrollMotion: opts.captureScrollMotion,
      })
      return {
        dna: toDesignDNA(tokens, opts.measurements, scrollMotion),
        tokens,
        screenshotPaths,
        outputDir,
      }
    },
  }
}
