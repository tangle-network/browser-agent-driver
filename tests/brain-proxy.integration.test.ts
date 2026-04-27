/**
 * Real-system integration test for Brain talking to an OpenAI-compatible proxy.
 *
 * The triple `(provider=openai, custom baseUrl, model=gpt-5.x)` was missing from
 * coverage — both the Gen 30 SSE-streaming bug AND the 2026-04-27 Responses-API
 * routing bug shipped because no test exercised it. This test spins up a tiny
 * node:http server that mimics router.tangle.tools's behavior:
 *   /v1/chat/completions → canonical OpenAI envelope
 *   /v1/responses        → 503 (matches the live router; LiteLLM doesn't proxy
 *                          the Responses API)
 *
 * If the brain ever routes a request to /v1/responses again (because someone
 * adds a new providerOptions.openai feature without gating on isProxiedOpenAI),
 * this test fails deterministically.
 *
 * NO MOCKS. Real fetch, real HTTP server, real AI SDK.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Brain } from '../src/brain/index.js'

interface RecordedRequest {
  method: string
  path: string
  body: string
}

interface MockProxy {
  port: number
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

async function startMockProxy(): Promise<MockProxy> {
  const requests: RecordedRequest[] = []

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString() })
    req.on('end', () => {
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', body })

      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        // Canonical OpenAI envelope. Important: the SDK validates the shape.
        const payload = {
          id: 'chatcmpl-mock-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-5.4-mock',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: 'ok-from-chat-completions' },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }

      if (req.url === '/v1/responses') {
        // Mimics the router's actual response — LiteLLM proxy not configured.
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'LiteLLM proxy not configured', type: 'server_error' } }))
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `not found: ${req.url}` } }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('Brain → OpenAI-compatible proxy', () => {
  let proxy: MockProxy

  beforeEach(async () => { proxy = await startMockProxy() })
  afterEach(async () => { await proxy.close() })

  it('routes gpt-5.x via custom baseUrl through /v1/chat/completions, NOT /v1/responses', async () => {
    const brain = new Brain({
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-test-mock',
      baseUrl: proxy.baseUrl,
      vision: false,
      llmTimeoutMs: 10_000,
    })

    const result = await brain.complete(
      'You are a test assistant. Reply with exactly the user\'s text.',
      'reply: ok',
      { maxOutputTokens: 50 },
    )

    expect(result.text).toContain('ok-from-chat-completions')

    // The crucial assertion: the SDK MUST NOT have hit /v1/responses, only
    // /v1/chat/completions. Every recorded request is what the AI SDK
    // actually sent over real fetch.
    const paths = proxy.requests.map((r) => r.path)
    expect(paths.every((p) => p === '/v1/chat/completions')).toBe(true)
    expect(paths.some((p) => p === '/v1/responses')).toBe(false)
  })

  it('chat-completions body has stream:false (Gen 30 force-non-streaming fix)', async () => {
    const brain = new Brain({
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-test-mock',
      baseUrl: proxy.baseUrl,
      vision: false,
      llmTimeoutMs: 10_000,
    })

    await brain.complete('system', 'user', { maxOutputTokens: 50 })

    expect(proxy.requests.length).toBeGreaterThan(0)
    const completionsReq = proxy.requests.find((r) => r.path === '/v1/chat/completions')
    expect(completionsReq).toBeDefined()
    const body = JSON.parse(completionsReq!.body) as { stream?: unknown }
    // The fetch override sets stream:false explicitly; absence (== SDK default)
    // would let the proxy default to SSE and break parsing.
    expect(body.stream).toBe(false)
  })

  it('without baseUrl (OpenAI direct path), forceReasoning IS still in generationOptions', () => {
    // Pure-function check — just inspect the gate output. This is the
    // counter-test to the proxy gate: when isProxiedOpenAI is false, the
    // forceReasoning path must remain on so OpenAI direct gets the right
    // shape for gpt-5.x reasoning models.
    const brain = new Brain({
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-test-mock',
      vision: false,
    })
    // generationOptions is private; reach in for the test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (brain as any).generationOptions(800, { provider: 'openai', model: 'gpt-5.4' })
    expect(opts.providerOptions?.openai?.forceReasoning).toBe(true)
  })

  it('with baseUrl (proxied), forceReasoning is OMITTED from generationOptions', () => {
    const brain = new Brain({
      provider: 'openai',
      model: 'gpt-5.4',
      apiKey: 'sk-test-mock',
      baseUrl: 'https://router.tangle.tools/v1',
      vision: false,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (brain as any).generationOptions(800, { provider: 'openai', model: 'gpt-5.4' })
    expect(opts.providerOptions).toBeUndefined()
  })
})
