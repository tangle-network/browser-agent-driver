import { describe, it, expect } from 'vitest'
import {
  parseCdxRows,
  sampleEvenly,
  cdxStampToIso,
  snapshotUrl,
  discoverWaybackSnapshots,
} from '../src/discover/wayback.js'
import { discoverTargets } from '../src/discover/index.js'

describe('parseCdxRows', () => {
  it('skips the header row and parses each capture', () => {
    const json = [
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
      ['com,stripe)/', '20100101120000', 'https://stripe.com/', 'text/html', '200', 'a', '1234'],
      ['com,stripe)/', '20200101120000', 'https://stripe.com/', 'text/html', '200', 'b', '4567'],
    ]
    const rows = parseCdxRows(json)
    expect(rows).toHaveLength(2)
    expect(rows[0].timestamp).toBe('20100101120000')
    expect(rows[1].timestamp).toBe('20200101120000')
  })

  it('returns empty for malformed input', () => {
    expect(parseCdxRows([])).toEqual([])
    expect(parseCdxRows(null)).toEqual([])
    expect(parseCdxRows({ x: 1 })).toEqual([])
  })

  it('skips rows with too few fields', () => {
    const json = [
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
      ['com,broken)/'], // bad row
      ['com,ok)/', '20240101000000', 'https://ok/', 'text/html', '200', 'd', '1'],
    ]
    expect(parseCdxRows(json)).toHaveLength(1)
  })
})

describe('sampleEvenly', () => {
  it('returns all rows when count >= length', () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3])
  })

  it('returns the middle element when count === 1', () => {
    expect(sampleEvenly([1, 2, 3, 4, 5], 1)).toEqual([3])
  })

  it('always includes first and last', () => {
    const rows = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    const sample = sampleEvenly(rows, 4)
    expect(sample[0]).toBe(10)
    expect(sample[sample.length - 1]).toBe(100)
    expect(sample).toHaveLength(4)
  })

  it('returns [] for count <= 0', () => {
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([])
  })
})

describe('cdxStampToIso', () => {
  it('formats correctly', () => {
    expect(cdxStampToIso('20100101120000')).toBe('2010-01-01T12:00:00Z')
  })
  it('throws on malformed input', () => {
    expect(() => cdxStampToIso('badstamp')).toThrow()
  })
})

describe('snapshotUrl', () => {
  it('produces a wayback URL', () => {
    const url = snapshotUrl('20100101120000', 'https://stripe.com/')
    expect(url).toBe('https://web.archive.org/web/20100101120000/https://stripe.com/')
  })
})

describe('discoverWaybackSnapshots', () => {
  it('fetches CDX, samples, and returns JobTargets', async () => {
    const fakeRows = [
      ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
      ['com,stripe)/', '20100101120000', 'https://stripe.com/', 'text/html', '200', 'a', '1'],
      ['com,stripe)/', '20140101120000', 'https://stripe.com/', 'text/html', '200', 'b', '1'],
      ['com,stripe)/', '20180101120000', 'https://stripe.com/', 'text/html', '200', 'c', '1'],
      ['com,stripe)/', '20220101120000', 'https://stripe.com/', 'text/html', '200', 'd', '1'],
      ['com,stripe)/', '20260101120000', 'https://stripe.com/', 'text/html', '200', 'e', '1'],
    ]
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => fakeRows,
    })) as unknown as typeof fetch
    const targets = await discoverWaybackSnapshots('https://stripe.com/', { count: 3, fetch: fetchImpl })
    expect(targets).toHaveLength(3)
    expect(targets[0].url).toBe('https://stripe.com/')
    expect(targets[0].snapshotUrl).toContain('web.archive.org')
    expect(targets[0].capturedAt).toBe('2010-01-01T12:00:00Z')
    expect(targets[2].capturedAt).toBe('2026-01-01T12:00:00Z')
  })

  it('throws on non-OK CDX response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    await expect(discoverWaybackSnapshots('https://x/', { fetch: fetchImpl })).rejects.toThrow(/CDX returned 503/)
  })

  it('returns [] when CDX yields no rows', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => [['header']] })) as unknown as typeof fetch
    const out = await discoverWaybackSnapshots('https://x/', { fetch: fetchImpl })
    expect(out).toEqual([])
  })
})

describe('discoverTargets', () => {
  it('list source returns one target per URL', async () => {
    const targets = await discoverTargets({ source: 'list', urls: ['https://a/', 'https://b/'] })
    expect(targets).toEqual([{ url: 'https://a/' }, { url: 'https://b/' }])
  })

  it('rejects an unknown source', async () => {
    await expect(discoverTargets({ source: 'unknown' as 'list', urls: [] })).rejects.toThrow(/unsupported/)
  })
})
