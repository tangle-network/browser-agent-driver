import { describe, it, expect } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure-JS helper, intentionally untyped (scripts/lib/)
import {
  parseSeedArgs,
  parseSourcesFile,
  toIngestTargets,
  makeEnsembleClassifier,
  jobToBeDoneFallback,
} from '../scripts/lib/seed-reference-corpus.mjs'

describe('parseSeedArgs', () => {
  it('collects positional URLs', () => {
    const opts = parseSeedArgs(['https://a.com', 'https://b.com'])
    expect(opts.urls).toEqual(['https://a.com', 'https://b.com'])
  })

  it('parses value flags into camelCase keys', () => {
    const opts = parseSeedArgs([
      '--file', 'sources.json',
      '--corpus-dir', 'out/corpus',
      '--provider', 'openai',
      '--model', 'gpt-5.4',
      '--api-key', 'sk-123',
      '--source', 'manual',
      'https://c.com',
    ])
    expect(opts).toMatchObject({
      file: 'sources.json',
      corpusDir: 'out/corpus',
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-123',
      source: 'manual',
      urls: ['https://c.com'],
    })
  })

  it('sets help on --help/-h', () => {
    expect(parseSeedArgs(['--help']).help).toBe(true)
    expect(parseSeedArgs(['-h']).help).toBe(true)
  })

  it('throws on an unknown flag', () => {
    expect(() => parseSeedArgs(['--bogus', 'x'])).toThrow(/unknown flag --bogus/)
  })

  it('throws when a value flag has no value', () => {
    expect(() => parseSeedArgs(['--file'])).toThrow(/--file requires a value/)
    expect(() => parseSeedArgs(['--file', '--provider', 'openai'])).toThrow(/--file requires a value/)
  })
})

describe('parseSourcesFile', () => {
  it('parses a JSON array of strings', () => {
    expect(parseSourcesFile('["https://a.com","https://b.com"]')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })

  it('parses a JSON array of target objects', () => {
    const out = parseSourcesFile('[{"url":"https://a.com","pageType":"marketing"}]')
    expect(out).toEqual([{ url: 'https://a.com', pageType: 'marketing' }])
  })

  it('throws on non-JSON', () => {
    expect(() => parseSourcesFile('not json')).toThrow(/not valid JSON/)
  })

  it('throws on a non-array root', () => {
    expect(() => parseSourcesFile('{"url":"https://a.com"}')).toThrow(/must be a JSON array/)
  })
})

describe('toIngestTargets', () => {
  it('maps positional URLs to headless targets', () => {
    expect(toIngestTargets({ urls: ['https://a.com'] })).toEqual([
      { url: 'https://a.com', headless: true },
    ])
  })

  it('preserves authored fields on object sources and defaults headless', () => {
    const targets = toIngestTargets({
      sources: [{ url: 'https://a.com', pageType: 'marketing', jobToBeDone: 'convert' }],
    })
    expect(targets).toEqual([
      { url: 'https://a.com', headless: true, pageType: 'marketing', jobToBeDone: 'convert' },
    ])
  })

  it('lets a per-target headless override win', () => {
    const targets = toIngestTargets({ sources: [{ url: 'https://a.com', headless: false }] })
    expect(targets[0].headless).toBe(false)
  })

  it('dedupes by url (first occurrence wins), trimming whitespace', () => {
    const targets = toIngestTargets({
      urls: ['https://a.com', '  https://a.com  '],
      sources: ['https://a.com', 'https://b.com'],
    })
    expect(targets.map((t: { url: string }) => t.url)).toEqual(['https://a.com', 'https://b.com'])
  })

  it('throws on an empty string url', () => {
    expect(() => toIngestTargets({ urls: ['   '] })).toThrow(/empty URL/)
  })

  it('throws on a malformed object source', () => {
    expect(() => toIngestTargets({ sources: [{ pageType: 'marketing' }] })).toThrow(/invalid file source/)
  })
})

describe('jobToBeDoneFallback', () => {
  it('uses the hostname', () => {
    expect(jobToBeDoneFallback('https://stripe.com/pricing')).toBe('use stripe.com')
  })

  it('degrades gracefully on a non-URL', () => {
    expect(jobToBeDoneFallback('not a url')).toBe('use this page')
  })
})

describe('makeEnsembleClassifier', () => {
  it('maps ensemble {type,intent} to {pageType,jobToBeDone} and synthesises a blank state', async () => {
    const calls: Array<{ url: string; state: { url: string; title: string; snapshot: string } }> = []
    const classifyEnsemble = async (input: {
      url: string
      state: { url: string; title: string; snapshot: string }
    }) => {
      calls.push(input)
      return { type: 'marketing', intent: 'convert visitors' }
    }
    const classifier = makeEnsembleClassifier({ classifyEnsemble, brain: {} })
    const out = await classifier.classify({ url: 'https://a.com' })
    expect(out).toEqual({ pageType: 'marketing', jobToBeDone: 'convert visitors' })
    expect(calls[0].state).toEqual({ url: 'https://a.com', title: '', snapshot: '' })
  })

  it('falls back to a hostname job when intent is empty, and unknown type passes through', async () => {
    const classifyEnsemble = async () => ({ type: 'unknown', intent: '   ' })
    const classifier = makeEnsembleClassifier({ classifyEnsemble, brain: {} })
    const out = await classifier.classify({ url: 'https://a.com/x' })
    expect(out).toEqual({ pageType: 'unknown', jobToBeDone: 'use a.com' })
  })

  it('requires a function classifyEnsemble and a brain', () => {
    expect(() => makeEnsembleClassifier({ classifyEnsemble: undefined, brain: {} })).toThrow(
      /must be a function/,
    )
    expect(() => makeEnsembleClassifier({ classifyEnsemble: async () => ({}), brain: undefined })).toThrow(
      /brain is required/,
    )
  })
})
