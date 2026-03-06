import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { generateWithSandboxBackend } from '../src/providers/sandbox-backend.js';

function createSseResponse(events: Array<{ type: string; properties?: Record<string, unknown> }>): Response {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('generateWithSandboxBackend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SANDBOX_BACKEND_TYPE;
    delete process.env.SANDBOX_SIDECAR_AUTH_TOKEN;
  });

  it('creates a sidecar session, streams text deltas, and cleans up the session', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/agents/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'session-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/agents/sessions/session-1/messages') && init?.method === 'POST') {
        return new Response(JSON.stringify({ info: { id: 'message-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/agents/events?sessionId=session-1') && init?.method === 'GET') {
        return createSseResponse([
          {
            type: 'message.part.updated',
            properties: {
              delta: '{"action":"wait"',
              part: {
                type: 'text',
                text: '{"action":"wait"',
                messageID: 'message-1',
              },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              delta: ',"ms":1000}',
              part: {
                type: 'text',
                text: '{"action":"wait","ms":1000}',
                messageID: 'message-1',
              },
            },
          },
          {
            type: 'message.complete',
            properties: {
              sessionID: 'session-1',
              messageID: 'message-1',
            },
          },
        ]);
      }
      if (url.includes('/agents/sessions/session-1') && init?.method === 'DELETE') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${init?.method || 'GET'} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    process.env.SANDBOX_SIDECAR_AUTH_TOKEN = 'sandbox-token';

    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect the page and decide the next action.' },
          { type: 'image', image: 'ZmFrZS1pbWFnZQ==', mediaType: 'image/jpeg' },
        ],
      },
    ];

    const result = await generateWithSandboxBackend({
      sidecarUrl: 'http://127.0.0.1:8080',
      backendType: 'claude-code',
      model: 'sonnet',
      system: 'Return JSON only.',
      messages,
      timeoutMs: 5_000,
    });

    expect(result.text).toBe('{"action":"wait","ms":1000}');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const createCall = fetchMock.mock.calls[0];
    expect(String(createCall[0])).toContain('/agents/sessions');
    expect(createCall[1]?.headers).toMatchObject({
      Authorization: 'Bearer sandbox-token',
    });
    expect(JSON.parse(String(createCall[1]?.body))).toMatchObject({
      backend: {
        type: 'claude-code',
        model: { model: 'sonnet' },
      },
    });

    const messageCall = fetchMock.mock.calls[1];
    const messageBody = JSON.parse(String(messageCall[1]?.body));
    expect(messageBody.system).toBe('Return JSON only.');
    expect(messageBody.parts[0]).toMatchObject({
      type: 'text',
    });
    expect(messageBody.parts[1]).toMatchObject({
      type: 'file',
      filename: 'browser-screenshot-1.jpg',
      mediaType: 'image/jpeg',
    });
  });

  it('captures final assistant text from raw item.completed agent_message events', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/agents/sessions') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'session-raw' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/agents/sessions/session-raw/messages') && init?.method === 'POST') {
        return new Response(JSON.stringify({ info: { id: 'message-raw' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/agents/events?sessionId=session-raw') && init?.method === 'GET') {
        return createSseResponse([
          {
            type: 'raw',
            properties: {
              event: {
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  text: '{"site":"news.ycombinator.com","main_heading":"Hacker News"}',
                },
              },
            },
          },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'session-raw',
            },
          },
        ]);
      }
      if (url.includes('/agents/sessions/session-raw') && init?.method === 'DELETE') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${init?.method || 'GET'} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await generateWithSandboxBackend({
      sidecarUrl: 'http://127.0.0.1:8080',
      backendType: 'codex',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'Read the screenshot.' }],
      timeoutMs: 5_000,
    });

    expect(result.text).toBe('{"site":"news.ycombinator.com","main_heading":"Hacker News"}');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
