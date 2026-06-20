import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { resolveReferenceContext } from '../src/design/audit/reference/reference-context.js'
import { summarizeDNA } from '../src/design/audit/reference/dna/derive.js'
import type {
  DesignDnaExtractor,
  DnaCapture,
  DesignDNA,
  ExtractPageDnaOptions,
} from '../src/design/audit/reference/contracts.js'
import type { DesignTokens } from '../src/types.js'

// Minimal type-honest DNA — the resolver only reads `dna` + `screenshotPaths`,
// never the fields, but we keep the fixture valid rather than casting.
const dna: DesignDNA = {
  url: 'https://ref.example',
  capturedAt: '2026-01-01T00:00:00.000Z',
  type: { steps: [], families: [] },
  color: { roles: { primary: [], secondary: [], accent: [], neutral: [], background: [], border: [] } },
  spacing: { steps: [], density: 'balanced' },
  radii: { steps: [] },
  motion: { durationsMs: [], easings: [], libraries: [] },
  layout: { density: 'balanced', archetype: 'content-flow' },
  components: { buttons: 0, inputs: 0, cards: 0, nav: 0 },
}

const tokens: DesignTokens = {
  url: 'https://ref.example',
  extractedAt: '2026-01-01T00:00:00.000Z',
  viewportsAudited: [],
  customProperties: {},
  colors: [],
  typography: { families: [], scale: [] },
  brand: {},
  logos: [],
  icons: [],
  fontFiles: [],
  images: [],
  videos: [],
  stylesheets: [],
  responsive: {},
  detectedLibraries: [],
}

/** Records the url it was asked to extract; returns a fixed capture. */
function fakeExtractor(
  over: Partial<DnaCapture> = {},
): { extractor: DesignDnaExtractor; calls: ExtractPageDnaOptions[] } {
  const calls: ExtractPageDnaOptions[] = []
  const extractor: DesignDnaExtractor = {
    async extract(opts: ExtractPageDnaOptions): Promise<DnaCapture> {
      calls.push(opts)
      return {
        dna,
        tokens,
        screenshotPaths: { desktop: '/tmp/ref-desktop.png' },
        outputDir: '/tmp/ref',
        ...over,
      }
    },
  }
  return { extractor, calls }
}

/** Always-throwing extractor for the fail-closed path. */
const throwingExtractor: DesignDnaExtractor = {
  async extract(): Promise<DnaCapture> {
    throw new Error('navigation timeout')
  },
}

describe('resolveReferenceContext', () => {
  it('returns undefined when no reference is supplied', async () => {
    const { extractor, calls } = fakeExtractor()
    const ctx = await resolveReferenceContext(undefined, { extractor })
    expect(ctx).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('classifies an http(s) reference as a url and passes it through unchanged', async () => {
    const { extractor, calls } = fakeExtractor()
    const ctx = await resolveReferenceContext('https://stripe.com', { extractor })
    expect(ctx?.kind).toBe('url')
    expect(calls[0]?.url).toBe('https://stripe.com')
    expect(ctx?.dna).toBe(dna)
    expect(ctx?.summary).toBe(summarizeDNA(dna))
    expect(ctx?.screenshotPath).toBe('/tmp/ref-desktop.png')
  })

  it('classifies a local path as a rip and addresses it via an absolute file:// URL', async () => {
    const { extractor, calls } = fakeExtractor()
    const ctx = await resolveReferenceContext('ripped/index.html', { extractor })
    expect(ctx?.kind).toBe('rip')
    expect(calls[0]?.url).toBe(pathToFileURL(path.resolve('ripped/index.html')).href)
  })

  it('passes an explicit file:// reference through as a rip', async () => {
    const { extractor, calls } = fakeExtractor()
    const ref = 'file:///abs/ripped/index.html'
    const ctx = await resolveReferenceContext(ref, { extractor })
    expect(ctx?.kind).toBe('rip')
    expect(calls[0]?.url).toBe(ref)
  })

  it('forwards headless/outputDir to the extractor', async () => {
    const { extractor, calls } = fakeExtractor()
    await resolveReferenceContext('https://ref.example', { extractor }, { headless: false, outputDir: '/out' })
    expect(calls[0]?.headless).toBe(false)
    expect(calls[0]?.outputDir).toBe('/out')
  })

  it('falls back to the first available screenshot when no desktop capture exists', async () => {
    const { extractor } = fakeExtractor({ screenshotPaths: { mobile: '/tmp/m.png' } })
    const ctx = await resolveReferenceContext('https://ref.example', { extractor })
    expect(ctx?.screenshotPath).toBe('/tmp/m.png')
  })

  it('omits screenshotPath entirely when the capture has none', async () => {
    const { extractor } = fakeExtractor({ screenshotPaths: {} })
    const ctx = await resolveReferenceContext('https://ref.example', { extractor })
    expect(ctx && 'screenshotPath' in ctx).toBe(false)
  })

  it('fails closed with an explicit error when the reference cannot be resolved', async () => {
    await expect(
      resolveReferenceContext('https://unreachable.example', { extractor: throwingExtractor }),
    ).rejects.toThrow(/--reference could not be resolved \(https:\/\/unreachable\.example\): navigation timeout/)
  })
})
