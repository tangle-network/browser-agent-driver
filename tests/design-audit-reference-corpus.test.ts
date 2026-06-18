import { describe, it, expect, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseExemplar, isExemplar, serializeExemplar } from '../src/design/audit/reference/corpus/schema.js'
import { createFileCorpusStore } from '../src/design/audit/reference/corpus/store.js'
import {
  buildExemplar,
  ingestCorpus,
  exemplarId,
  SEED_ELO,
  type ExemplarClassifier,
} from '../src/design/audit/reference/corpus/build.js'
import { toDesignDNA } from '../src/design/audit/reference/dna/derive.js'
import { aestheticDescriptor } from '../src/design/audit/reference/dna/descriptor.js'
import { HashEmbeddingProvider } from '../src/design/audit/reference/retrieval/embedding-hash.js'
import type {
  DesignTokens,
  DesignDNA,
  Exemplar,
  DnaCapture,
  DesignDnaExtractor,
  ExtractPageDnaOptions,
  CorpusReader,
  CorpusWriter,
} from '../src/design/audit/reference/contracts.js'

// ── synthetic fixtures (clearly NOT real-site data — derived in-test only) ────

function makeTokens(over: Partial<DesignTokens> = {}): DesignTokens {
  return {
    url: 'https://fixture.example',
    extractedAt: '2026-01-01T00:00:00.000Z',
    viewportsAudited: ['desktop'],
    customProperties: {},
    colors: [
      { value: '#2563eb', hex: '#2563eb', count: 40, properties: ['backgroundColor'], cluster: 'primary' },
      { value: '#111827', hex: '#111827', count: 200, properties: ['color'], cluster: 'neutral' },
      { value: '#ffffff', hex: '#ffffff', count: 150, properties: ['backgroundColor'], cluster: 'background' },
    ],
    typography: {
      families: [{ family: 'Inter', weights: [400, 700], classification: 'body' }],
      scale: [
        { fontSize: '16px', fontWeight: '400', lineHeight: '24px', letterSpacing: 'normal', fontFamily: 'Inter, sans-serif', usage: 'body', count: 50 },
        { fontSize: '32px', fontWeight: '700', lineHeight: '40px', letterSpacing: 'normal', fontFamily: 'Inter, sans-serif', usage: 'heading', count: 4 },
      ],
    },
    brand: {},
    logos: [],
    icons: [],
    fontFiles: [],
    images: [],
    videos: [],
    stylesheets: [],
    responsive: {
      desktop: {
        width: 1280,
        height: 800,
        gridBaseUnit: 8,
        spacing: [
          { value: '8px', count: 40, properties: ['padding'] },
          { value: '16px', count: 60, properties: ['padding'] },
        ],
        borders: [{ borderRadius: '8px', count: 30 }],
        shadows: [],
        components: {
          buttons: [{ fingerprint: 'btn-a', count: 1, styles: {} }],
          inputs: [],
          cards: [],
          nav: [{ selector: 'nav.main', layout: {}, linkCount: 3, linkStyles: {} }],
        },
        animations: [{ property: 'transition', value: 'all 0.2s ease', count: 1 }],
      },
    },
    detectedLibraries: [],
    ...over,
  }
}

const makeDNA = (over: Partial<DesignTokens> = {}): DesignDNA => toDesignDNA(makeTokens(over))

function makeExemplar(over: Partial<Exemplar> = {}): Exemplar {
  return {
    id: 'manual-fixture-example',
    source: 'manual',
    url: 'https://fixture.example',
    pageType: 'marketing',
    jobToBeDone: 'convert a visitor to signup',
    dna: makeDNA(),
    screenshotPath: 'screenshots/manual-fixture-example.png',
    aestheticVector: [0.1, 0.2, 0.3, 0.4],
    eloRating: SEED_ELO,
    ...over,
  }
}

// ── tmp-dir lifecycle ────────────────────────────────────────────────────────

const tmpDirs: string[] = []
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bad-corpus-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

// ── schema ───────────────────────────────────────────────────────────────────

describe('parseExemplar / isExemplar / serializeExemplar', () => {
  it('round-trips a valid exemplar through serialise → parse unchanged', () => {
    const e = makeExemplar()
    const restored = parseExemplar(JSON.parse(serializeExemplar(e)))
    expect(restored).toEqual(e)
    expect(isExemplar(JSON.parse(serializeExemplar(e)))).toBe(true)
  })

  it('rejects rows missing dna, pageType, or aestheticVector (fail-closed, never defaulted)', () => {
    for (const field of ['dna', 'pageType', 'aestheticVector'] as const) {
      const raw: Record<string, unknown> = JSON.parse(serializeExemplar(makeExemplar()))
      delete raw[field]
      expect(() => parseExemplar(raw)).toThrow(/invalid exemplar/)
      expect(isExemplar(raw)).toBe(false)
    }
  })

  it('rejects an empty / non-numeric aestheticVector and a non-enum pageType', () => {
    expect(isExemplar(makeExemplar({ aestheticVector: [] }))).toBe(false)
    expect(isExemplar({ ...makeExemplar(), aestheticVector: ['x'] })).toBe(false)
    expect(isExemplar({ ...makeExemplar(), pageType: 'not-a-real-type' })).toBe(false)
  })

  it('rejects a structurally-broken DNA (missing nested required fields)', () => {
    const broken = makeExemplar()
    expect(isExemplar({ ...broken, dna: { ...broken.dna, spacing: { density: 'sparse' } } })).toBe(false)
    expect(isExemplar({ ...broken, dna: { ...broken.dna, layout: { archetype: 'x' } } })).toBe(false)
  })

  it('whitelists known fields: drops unknown keys and resists prototype pollution', () => {
    const hostileJson = serializeExemplar(makeExemplar()).replace(
      '{',
      '{ "__proto__": { "polluted": true }, "constructor": "evil", "extraEvil": 1,',
    )
    const hostile = JSON.parse(hostileJson)
    const parsed = parseExemplar(hostile)

    // no prototype pollution leaked to Object.prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // unknown keys never survive into the corpus row
    expect((parsed as Record<string, unknown>).extraEvil).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
    expect(parsed.id).toBe(makeExemplar().id)
  })
})

// ── store ──────────────────────────────────────────────────────────────────────

describe('createFileCorpusStore', () => {
  it('round-trips upsert → load and resolves get by id, null on miss', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)

    const a = makeExemplar({ id: 'manual-a', url: 'https://a.example' })
    const b = makeExemplar({ id: 'manual-b', url: 'https://b.example', pageType: 'dashboard' })
    await store.upsert(a)
    await store.upsert(b)

    const loaded = await store.load()
    expect(loaded.map((e) => e.id).sort()).toEqual(['manual-a', 'manual-b'])
    expect(await store.get('manual-a')).toEqual(a)
    expect(await store.get('manual-b')).toEqual(b)
    // a miss returns null — never a fabricated row
    expect(await store.get('manual-missing')).toBeNull()
  })

  it('upsert replaces an existing row by id (no duplicate file)', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)
    await store.upsert(makeExemplar({ id: 'manual-x', eloRating: 1500 }))
    await store.upsert(makeExemplar({ id: 'manual-x', eloRating: 1700 }))
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].eloRating).toBe(1700)
  })

  it('fails closed on a missing dir (empty corpus, never throws)', async () => {
    const store = createFileCorpusStore(path.join(os.tmpdir(), `bad-corpus-absent-${Date.now()}`))
    expect(await store.load()).toEqual([])
    expect(await store.get('anything')).toBeNull()
  })

  it('skips corrupt / foreign records on load rather than poisoning the corpus', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)
    await store.upsert(makeExemplar({ id: 'manual-good' }))
    await fs.writeFile(path.join(dir, 'not-json.json'), '{ this is not json', 'utf8')
    await fs.writeFile(path.join(dir, 'wrong-schema.json'), JSON.stringify({ hello: 'world' }), 'utf8')

    const loaded = await store.load()
    expect(loaded.map((e) => e.id)).toEqual(['manual-good'])
  })

  it('saveScreenshot stores a sidecar and resolveScreenshot returns an absolute, existing path', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)
    const rel = await store.saveScreenshot('manual-shot', Buffer.from('\x89PNG fixture bytes'))
    expect(rel).toBe(path.join('screenshots', 'manual-shot.png'))

    const abs = store.resolveScreenshot(makeExemplar({ screenshotPath: rel }))
    expect(path.isAbsolute(abs)).toBe(true)
    await expect(fs.readFile(abs)).resolves.toBeInstanceOf(Buffer)
  })

  it('guards id-based reads against path traversal', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)
    expect(await store.get('../../etc/passwd')).toBeNull()
    expect(await store.get('a/b')).toBeNull()
    await expect(store.saveScreenshot('../escape', Buffer.from('x'))).rejects.toThrow(/unsafe/)
  })

  it('exposes the reader and writer halves independently (CorpusReader / CorpusWriter)', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)
    const reader: CorpusReader = store
    const writer: CorpusWriter = store
    expect(typeof reader.load).toBe('function')
    expect(typeof reader.get).toBe('function')
    expect(typeof reader.resolveScreenshot).toBe('function')
    expect(typeof writer.upsert).toBe('function')
    expect(typeof writer.saveScreenshot).toBe('function')
  })
})

// ── build / ingest (injected mock extractor + embedder + classifier) ──────────

function fakeExtractor(screenshotPaths: Record<string, string> = { desktop: '/fake/desktop.png' }): DesignDnaExtractor {
  return {
    async extract(opts: ExtractPageDnaOptions): Promise<DnaCapture> {
      const tokens = makeTokens({ url: opts.url })
      return {
        dna: toDesignDNA(tokens, opts.measurements),
        tokens,
        screenshotPaths,
        outputDir: '/fake/out',
      }
    },
  }
}

describe('buildExemplar', () => {
  it('reverse-engineers a well-formed exemplar with a stable id and seeded elo', async () => {
    let classifyInput: { dna: DesignDNA } | undefined
    const classifier: ExemplarClassifier = {
      async classify(input) {
        classifyInput = input
        return { pageType: 'marketing', jobToBeDone: 'convert a visitor' }
      },
    }

    const exemplar = await buildExemplar({
      url: 'https://stripe.fixture/pricing',
      extractor: fakeExtractor({ desktop: '/fake/desktop.png' }),
      embedder: HashEmbeddingProvider,
      classifier,
    })

    expect(exemplar.id).toBe(exemplarId('manual', 'https://stripe.fixture/pricing'))
    expect(exemplar.id).toBe('manual-stripe-fixture-pricing')
    expect(exemplar.source).toBe('manual')
    expect(exemplar.pageType).toBe('marketing')
    expect(exemplar.jobToBeDone).toBe('convert a visitor')
    expect(exemplar.eloRating).toBe(SEED_ELO)
    expect(exemplar.screenshotPath).toBe('/fake/desktop.png')

    // the vector is the real hash embedding of the aesthetic descriptor (no network)
    expect(exemplar.aestheticVector).toHaveLength(256)
    const [expected] = await HashEmbeddingProvider.embed([aestheticDescriptor(exemplar.dna)])
    expect(exemplar.aestheticVector).toEqual(expected)

    // the classifier saw the captured DNA, and the row is schema-valid
    expect(classifyInput?.dna).toEqual(exemplar.dna)
    expect(isExemplar(exemplar)).toBe(true)
  })

  it('uses authored pageType + jobToBeDone and never invokes the classifier', async () => {
    let called = false
    const classifier: ExemplarClassifier = {
      async classify() {
        called = true
        return { pageType: 'unknown', jobToBeDone: 'x' }
      },
    }
    const exemplar = await buildExemplar({
      url: 'https://docs.fixture/guide',
      extractor: fakeExtractor(),
      embedder: HashEmbeddingProvider,
      classifier,
      source: 'awwwards',
      pageType: 'docs',
      jobToBeDone: 'help a developer integrate',
      eloRating: 1700,
    })
    expect(called).toBe(false)
    expect(exemplar.source).toBe('awwwards')
    expect(exemplar.pageType).toBe('docs')
    expect(exemplar.jobToBeDone).toBe('help a developer integrate')
    expect(exemplar.eloRating).toBe(1700)
    expect(exemplar.id).toBe('awwwards-docs-fixture-guide')
  })

  it('fails closed when neither an authored type/job nor a classifier is supplied', async () => {
    await expect(
      buildExemplar({ url: 'https://x.fixture', extractor: fakeExtractor(), embedder: HashEmbeddingProvider }),
    ).rejects.toThrow(/classifier|fabricated/)
  })
})

describe('ingestCorpus', () => {
  it('builds, relocates screenshots into the corpus, and upserts every target', async () => {
    const dir = await mkTmp()
    const srcDir = await mkTmp()
    const store = createFileCorpusStore(dir)

    // a REAL on-disk screenshot so relocation exercises the writer end-to-end
    const shotPath = path.join(srcDir, 'shot.png')
    await fs.writeFile(shotPath, Buffer.from('\x89PNG fixture'))

    const classifier: ExemplarClassifier = {
      async classify() {
        return { pageType: 'marketing', jobToBeDone: 'convert' }
      },
    }

    const result = await ingestCorpus({
      store,
      extractor: fakeExtractor({ desktop: shotPath }),
      embedder: HashEmbeddingProvider,
      classifier,
      targets: [{ url: 'https://good.fixture/a' }, { url: 'https://good.fixture/b', source: 'rip' }],
    })

    expect(result.failed).toEqual([])
    expect(result.added).toEqual([
      exemplarId('manual', 'https://good.fixture/a'),
      exemplarId('rip', 'https://good.fixture/b'),
    ])

    const loaded = await store.load()
    const good = loaded.find((e) => e.url === 'https://good.fixture/a')
    expect(good).toBeDefined()
    // screenshot was relocated into the corpus (corpus-relative path) and resolves
    // to an existing file via the reader
    expect(good!.screenshotPath).toBe(path.join('screenshots', `${good!.id}.png`))
    const abs = store.resolveScreenshot(good!)
    await expect(fs.readFile(abs)).resolves.toBeInstanceOf(Buffer)
  })

  it('records a per-target failure without aborting the rest of the batch', async () => {
    const dir = await mkTmp()
    const store = createFileCorpusStore(dir)

    // a classifier that throws on one specific url
    const classifier: ExemplarClassifier = {
      async classify({ url }) {
        if (url.includes('explode')) throw new Error('classifier blew up')
        return { pageType: 'tool', jobToBeDone: 'do one thing' }
      },
    }

    const result = await ingestCorpus({
      store,
      extractor: fakeExtractor(),
      embedder: HashEmbeddingProvider,
      classifier,
      source: 'manual',
      targets: [{ url: 'https://ok.fixture/one' }, { url: 'https://explode.fixture/two' }],
    })

    expect(result.added).toEqual([exemplarId('manual', 'https://ok.fixture/one')])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].url).toBe('https://explode.fixture/two')
    expect(result.failed[0].reason).toMatch(/blew up/)
    // the good target still landed
    expect((await store.load()).map((e) => e.url)).toEqual(['https://ok.fixture/one'])
  })
})
