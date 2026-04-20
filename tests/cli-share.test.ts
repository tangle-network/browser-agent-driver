/**
 * `bad share <run-id>` — createShareLink unit coverage.
 *
 * Mocks global fetch; covers happy path, auth failure, missing key,
 * 404 run-not-found, malformed response. Clipboard copy is not tested
 * here (best-effort, environmentally dependent) — `handleShareCommand`
 * is covered separately via an execFile-based test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShareLink, ShareError } from '../src/cli-share.js'

type FetchInit = RequestInit & { body?: string }

function mockFetch(responses: { status: number; body: unknown; text?: string }[]) {
  let i = 0
  return vi.fn(async (_url: string, _init: FetchInit): Promise<Response> => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    const textBody = r.text ?? (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: `status ${r.status}`,
      text: async () => textBody,
      json: async () => (typeof r.body === 'string' ? JSON.parse(textBody) : r.body),
    } as Response
  })
}

describe('createShareLink', () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.BAD_APP_API_KEY

  beforeEach(() => {
    delete process.env.BAD_APP_API_KEY
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.BAD_APP_API_KEY
    else process.env.BAD_APP_API_KEY = originalKey
  })

  it('throws ShareError with setup hint when no API key present', async () => {
    await expect(createShareLink({ runId: 'run_x' })).rejects.toThrow(ShareError)
    await expect(createShareLink({ runId: 'run_x' })).rejects.toThrow(/API key required/)
  })

  it('returns parsed link on a 201 response', async () => {
    globalThis.fetch = mockFetch([{
      status: 201,
      body: {
        id: 'sh-abc',
        url: 'https://browser.tangle.tools/api/share/sh-abc',
        expiresAt: '2026-05-01T00:00:00Z',
        visibility: 'metadata',
      },
    }]) as unknown as typeof fetch

    const link = await createShareLink({ runId: 'run_x', apiKey: 'bad_sk_test' })
    expect(link.id).toBe('sh-abc')
    expect(link.url).toContain('/api/share/sh-abc')
    expect(link.visibility).toBe('metadata')
  })

  it('defaults visibility to metadata when not specified', async () => {
    const fetchMock = mockFetch([{
      status: 201,
      body: { id: 'sh-1', url: 'u', expiresAt: '', visibility: 'metadata' },
    }])
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await createShareLink({ runId: 'run_x', apiKey: 'bad_sk_test' })
    const call = fetchMock.mock.calls[0]
    const init = call[1] as { body: string }
    expect(JSON.parse(init.body)).toMatchObject({ visibility: 'metadata' })
  })

  it('passes through explicit visibility=full', async () => {
    const fetchMock = mockFetch([{
      status: 201,
      body: { id: 'sh-1', url: 'u', expiresAt: '', visibility: 'full' },
    }])
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await createShareLink({ runId: 'run_x', apiKey: 'bad_sk_test', visibility: 'full' })
    const init = fetchMock.mock.calls[0][1] as { body: string }
    expect(JSON.parse(init.body).visibility).toBe('full')
  })

  it('maps 404 to run-not-found error with actionable hint', async () => {
    globalThis.fetch = mockFetch([{ status: 404, body: {} }]) as unknown as typeof fetch
    await expect(
      createShareLink({ runId: 'run_missing', apiKey: 'bad_sk_test' }),
    ).rejects.toThrow(/Run not found/)
  })

  it('maps 401 / 403 to API-key rejected', async () => {
    globalThis.fetch = mockFetch([{ status: 401, body: {} }]) as unknown as typeof fetch
    await expect(createShareLink({ runId: 'run_x', apiKey: 'bad' })).rejects.toThrow(/API key rejected/)
  })

  it('rejects malformed success payloads (missing id / url)', async () => {
    globalThis.fetch = mockFetch([{
      status: 201,
      body: { whatever: true },
    }]) as unknown as typeof fetch
    await expect(createShareLink({ runId: 'run_x', apiKey: 'bad_sk_test' })).rejects.toThrow(/Malformed/)
  })

  it('uses BAD_APP_API_KEY from env when --api-key absent', async () => {
    process.env.BAD_APP_API_KEY = 'bad_sk_from_env'
    const fetchMock = mockFetch([{
      status: 201,
      body: { id: 'sh-1', url: 'u', expiresAt: '', visibility: 'metadata' },
    }])
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await createShareLink({ runId: 'run_x' })
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer bad_sk_from_env')
  })

  it('honors custom baseUrl', async () => {
    const fetchMock = mockFetch([{
      status: 201,
      body: { id: 'sh-1', url: 'u', expiresAt: '', visibility: 'metadata' },
    }])
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await createShareLink({ runId: 'run_x', apiKey: 'bad_sk_test', baseUrl: 'http://localhost:8787' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8787/api/ci/share-links')
  })
})
