import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateTokens, diffTokens, groupByUrl } from '../src/reports/tokens.js'
import { renderBrandEvolution } from '../src/reports/templates.js'
import type { Job } from '../src/jobs/types.js'
import type { DesignTokens } from '../src/types.js'

function writeTokens(dir: string, name: string, tokens: Partial<DesignTokens>): string {
  const p = join(dir, `${name}.json`)
  writeFileSync(p, JSON.stringify({
    url: tokens.url ?? 'https://x/',
    extractedAt: new Date().toISOString(),
    viewportsAudited: ['1440'],
    customProperties: {},
    colors: [], typography: { families: [], scale: [] },
    brand: {}, logos: [], icons: [], fontFiles: [], images: [], videos: [],
    stylesheets: [], responsive: {}, detectedLibraries: [],
    ...tokens,
  }))
  return p
}

function makeJob(results: Job['results']): Job {
  return {
    jobId: 'tj',
    spec: { kind: 'comparative-audit', discover: { source: 'wayback', urls: ['https://x/'] } },
    status: 'completed',
    createdAt: new Date().toISOString(),
    targets: results.map(r => ({ url: r.url, snapshotUrl: r.snapshotUrl, capturedAt: r.capturedAt })),
    results,
    totalCostUSD: 0,
  }
}

describe('aggregateTokens', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('reads each ok result\'s tokens.json and projects to TokenSummary', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-tok-'))
    const t1 = writeTokens(dir, 't1', {
      colors: [{ value: 'rgb(0,113,227)', hex: '#0071e3', count: 50, properties: ['color'] }],
      typography: { families: [{ family: 'Inter', weights: [400, 600], classification: 'body' }], scale: [{ fontSize: '16px', fontWeight: '400', lineHeight: '24px', letterSpacing: '0', fontFamily: 'Inter', tag: 'body', count: 12 }] },
      brand: { themeColor: '#0071e3', title: 'Stripe' },
      detectedLibraries: ['tailwind'],
    })
    const job = makeJob([
      { url: 'https://stripe.com/', status: 'ok', runId: 'run-1', tokensPath: t1 },
      { url: 'https://stripe.com/', status: 'failed', error: 'x' },
    ])
    const summaries = aggregateTokens(job)
    expect(summaries).toHaveLength(1)
    expect(summaries[0].colors[0].hex).toBe('#0071e3')
    expect(summaries[0].fontFamilies[0].family).toBe('Inter')
    expect(summaries[0].brand.themeColor).toBe('#0071e3')
    expect(summaries[0].typeScaleEntries).toBe(1)
    expect(summaries[0].detectedLibraries).toEqual(['tailwind'])
  })

  it('skips results without tokensPath', () => {
    const job = makeJob([{ url: 'https://x/', status: 'ok', runId: 'r' }])
    expect(aggregateTokens(job)).toEqual([])
  })

  it('skips corrupt token files', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-tok-'))
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not valid json')
    const job = makeJob([{ url: 'https://x/', status: 'ok', runId: 'r', tokensPath: bad }])
    expect(aggregateTokens(job)).toEqual([])
  })

  it('sorts colors by usage count descending', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-tok-'))
    const t = writeTokens(dir, 't', {
      colors: [
        { value: 'a', hex: '#aaa', count: 10, properties: [] },
        { value: 'b', hex: '#bbb', count: 100, properties: [] },
        { value: 'c', hex: '#ccc', count: 50, properties: [] },
      ],
    })
    const summaries = aggregateTokens(makeJob([{ url: 'x', status: 'ok', runId: 'r', tokensPath: t }]))
    expect(summaries[0].colors.map(c => c.hex)).toEqual(['#bbb', '#ccc', '#aaa'])
  })
})

describe('diffTokens', () => {
  it('produces colorsAdded / colorsRemoved / colorsCommon', () => {
    const a = { url: 'x', runId: '1', brand: {}, fontFamilies: [], colors: [{ value: '', hex: '#aaa', count: 1, properties: [] }, { value: '', hex: '#bbb', count: 1, properties: [] }], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const b = { url: 'x', runId: '2', brand: {}, fontFamilies: [], colors: [{ value: '', hex: '#bbb', count: 1, properties: [] }, { value: '', hex: '#ccc', count: 1, properties: [] }], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const d = diffTokens(a, b)
    expect(d.colorsAdded).toEqual(['#ccc'])
    expect(d.colorsRemoved).toEqual(['#aaa'])
    expect(d.colorsCommon).toBe(1)
  })

  it('detects font family swaps', () => {
    const a = { url: 'x', runId: '1', brand: {}, fontFamilies: [{ family: 'Helvetica', weights: [400], classification: 'body' as const }], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const b = { url: 'x', runId: '2', brand: {}, fontFamilies: [{ family: 'Inter', weights: [400], classification: 'body' as const }], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const d = diffTokens(a, b)
    expect(d.familiesAdded).toEqual(['Inter'])
    expect(d.familiesRemoved).toEqual(['Helvetica'])
  })

  it('flags brand metadata changes', () => {
    const a = { url: 'x', runId: '1', brand: { themeColor: '#000', title: 'Old' }, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const b = { url: 'x', runId: '2', brand: { themeColor: '#fff', title: 'New' }, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] }
    const d = diffTokens(a, b)
    expect(d.brandChanges.map(c => c.field).sort()).toEqual(['themeColor', 'title'])
  })

  it('detects library adoption / drop', () => {
    const a = { url: 'x', runId: '1', brand: {}, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: ['bootstrap'] }
    const b = { url: 'x', runId: '2', brand: {}, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: ['tailwind'] }
    const d = diffTokens(a, b)
    expect(d.librariesAdded).toEqual(['tailwind'])
    expect(d.librariesRemoved).toEqual(['bootstrap'])
  })
})

describe('groupByUrl', () => {
  it('groups summaries by URL and sorts by capturedAt', () => {
    const summaries = [
      { url: 'a', runId: '1', capturedAt: '2020-01-01T00:00:00Z', brand: {}, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] },
      { url: 'a', runId: '2', capturedAt: '2010-01-01T00:00:00Z', brand: {}, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] },
      { url: 'b', runId: '3', capturedAt: '2024-01-01T00:00:00Z', brand: {}, fontFamilies: [], colors: [], typeScaleEntries: 0, logos: [], fontFiles: [], detectedLibraries: [] },
    ]
    const series = groupByUrl(summaries)
    const a = series.find(s => s.url === 'a')!
    expect(a.snapshots[0].capturedAt).toBe('2010-01-01T00:00:00Z')
    expect(a.snapshots[1].capturedAt).toBe('2020-01-01T00:00:00Z')
  })
})

describe('renderBrandEvolution', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('returns a placeholder when no tokens are in the job', () => {
    const job = makeJob([{ url: 'https://x/', status: 'ok', runId: 'r' }])
    const md = renderBrandEvolution(job)
    expect(md).toMatch(/No tokens.json files were produced/)
  })

  it('renders one section per URL with snapshots in order', () => {
    dir = mkdtempSync(join(tmpdir(), 'bad-tok-'))
    const t1 = writeTokens(dir, 't1', { colors: [{ value: '', hex: '#000', count: 1, properties: [] }] })
    const t2 = writeTokens(dir, 't2', { colors: [{ value: '', hex: '#fff', count: 1, properties: [] }] })
    const job = makeJob([
      { url: 'https://x/', status: 'ok', runId: 'r1', tokensPath: t1, capturedAt: '2010-01-01T00:00:00Z' },
      { url: 'https://x/', status: 'ok', runId: 'r2', tokensPath: t2, capturedAt: '2020-01-01T00:00:00Z' },
    ])
    const md = renderBrandEvolution(job)
    expect(md).toMatch(/## https:\/\/x\//)
    expect(md).toMatch(/### 2010-01-01/)
    expect(md).toMatch(/### 2020-01-01/)
    expect(md).toMatch(/Δ vs 2010-01-01/)
    expect(md).toMatch(/\+1 new colors/)
    expect(md).toMatch(/−1 removed/)
  })
})
