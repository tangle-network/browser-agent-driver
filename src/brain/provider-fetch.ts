/**
 * Provider IO adapters: the cli-bridge json-text output shape and the
 * non-streaming fetch shim for OpenAI-compatible proxies that default to SSE.
 */

const JSON_TEXT_OUTPUT = {
  name: 'json-text',
  responseFormat: Promise.resolve({ type: 'json' as const }),
  async parseCompleteOutput({ text }: { text: string }) {
    return text;
  },
  async parsePartialOutput({ text }: { text: string }) {
    return { partial: text };
  },
  createElementStreamTransform() {
    return undefined;
  },
};

/**
 * Build a fetch replacement that forces `"stream": false` on chat completions
 * bodies for OpenAI-compatible gateways that default to SSE streaming.
 */
function createForceNonStreamingFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body && typeof init.body === 'string') {
      const body = init.body
      // Cheap content-sniff so we only rewrite chat-completions shaped bodies,
      // not arbitrary POSTs the caller might make (embeddings, etc.).
      if (body.includes('"messages"') && body.includes('"model"')) {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>
          if (parsed.stream === undefined || parsed.stream === true) {
            parsed.stream = false
            init = { ...init, body: JSON.stringify(parsed) }
          }
        } catch {
          // Non-JSON body — pass through unchanged.
        }
      }
    }
    return fetch(input, init)
  }
}

export { JSON_TEXT_OUTPUT, createForceNonStreamingFetch };
