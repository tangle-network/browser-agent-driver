import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileSystemRawProviderSink } from '@tangle-network/agent-eval'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureBrainGenerate,
  captureProviderFetch,
  isAgentEvalCaptureConfigured,
} from '../src/brain/agent-eval-capture.js'

const ENV_KEYS = [
  'BAD_AGENT_EVAL_CAPTURE_DIR',
  'BAD_AGENT_EVAL_TRACE_DIR',
  'BAD_AGENT_EVAL_CAPTURE_REQUIRE',
  'BAD_AGENT_EVAL_SCENARIO_ID',
  'BAD_AGENT_EVAL_CANDIDATE_ID',
  'BAD_AGENT_EVAL_RUN_ID',
  'BAD_AGENT_EVAL_CAPTURE_BODY_BYTES',
] as const

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key]
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
})

describe('agent-eval provider capture', () => {
  it('records schema-valid raw provider events for captured generations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-agent-eval-capture-'))
    process.env.BAD_AGENT_EVAL_CAPTURE_DIR = dir
    process.env.BAD_AGENT_EVAL_CAPTURE_REQUIRE = '1'
    process.env.BAD_AGENT_EVAL_SCENARIO_ID = 'capture-test'
    process.env.BAD_AGENT_EVAL_CANDIDATE_ID = 'candidate'
    process.env.BAD_AGENT_EVAL_RUN_ID = 'capture-run'

    expect(isAgentEvalCaptureConfigured()).toBe(true)

    const result = await captureBrainGenerate({
      provider: 'openai',
      model: 'gpt-5.4',
      system: 'Return JSON.',
      messages: [],
    }, async () => {
      const response = await captureProviderFetch(
        'https://api.openai.com/v1/chat/completions?trace=1',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token-1234567890',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-5.4',
            messages: [],
            apiKey: 'test-secret-1234567890',
          }),
        },
        async () => new Response(JSON.stringify({ id: 'chatcmpl-test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      expect(response.status).toBe(200)
      return {
        text: '{"ok":true}',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
        },
      }
    })

    expect(result.text).toBe('{"ok":true}')

    const sink = new FileSystemRawProviderSink({ dir: path.join(dir, 'raw-provider') })
    const events = await sink.list()

    expect(events).toHaveLength(2)
    expect(events.map((event) => event.direction)).toEqual(['request', 'response'])
    expect(events[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      endpoint: '/v1/chat/completions?trace=1',
      baseUrl: 'https://api.openai.com',
      redactedFields: expect.any(Array),
    })
    expect(events[0].runId).toBe(events[1].runId)
    expect(events[0].spanId).toBe(events[1].spanId)
  })
})
