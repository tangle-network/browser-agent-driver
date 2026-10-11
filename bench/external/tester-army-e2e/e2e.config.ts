import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { createOpenAI } from '@ai-sdk/openai';

// Spike config: local, zero-spend model via Ollama's OpenAI-compatible
// endpoint. For a credentialed run, unset OPENAI_BASE_URL and provide a real
// OPENAI_API_KEY, or swap in any AI SDK provider (see node_modules/e2e/docs/
// models.mdx).
const provider = createOpenAI({
  baseURL: process.env.OPENAI_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey: process.env.OPENAI_API_KEY || 'local-smoke',
});

export default {
  agents: { default: { model: provider(process.env.E2E_MODEL ?? 'qwen2.5:3b') } },
  targets: [
    {
      engine: web(),
      app: {
        url: process.env.APP_URL ?? 'http://127.0.0.1:8123',
        command: {
          executable: 'python3',
          args: ['-m', 'http.server', '8123', '--bind', '127.0.0.1', '-d', '../../fixtures'],
          reuseExisting: true,
        },
      },
    },
  ],
} satisfies E2EConfig;
