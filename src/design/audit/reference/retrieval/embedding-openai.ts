/**
 * Network-backed embedder — the ADAPTER half of the embedding boundary.
 *
 * `OpenAiEmbeddingProvider` implements `EmbeddingProvider` over the OpenAI
 * embeddings endpoint via a `dynamic import('openai')` (the import is confined to
 * this one adapter so the sibling `embedding-hash.ts` stays literally pure and
 * the `openai` dep is never loaded on the offline path). The API key is resolved
 * through the existing `resolveProviderApiKey` provider abstraction — never a
 * hand-rolled fetch and never a duplicated env lookup.
 *
 * `resolveEmbeddingProvider` is the swap point: it returns the OpenAI provider
 * when a key is present and falls back to the deterministic `HashEmbeddingProvider`
 * otherwise, so the engine and its unit tests run with zero provider by default.
 */

import type { AestheticVector, EmbeddingProvider } from '../contracts.js'
import { resolveProviderApiKey } from '../../../../provider-defaults.js'
import { HashEmbeddingProvider } from './embedding-hash.js'

/** Small, cheap, 1536-dim default. A corpus must be embedded with the same model. */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'

/** L2-normalise so provider vectors are unit-length like the hash provider's. */
function l2normalize(v: number[]): AestheticVector {
  let norm = 0
  for (const x of v) norm += x * x
  if (norm === 0) return v.slice()
  const inv = 1 / Math.sqrt(norm)
  return v.map((x) => x * inv)
}

/**
 * Build an OpenAI-backed `EmbeddingProvider` for `model`, resolving its key lazily
 * (at `embed` time) through `getApiKey` so the provider can be a stable object.
 */
function createOpenAiProvider(model: string, getApiKey: () => string | undefined): EmbeddingProvider {
  return {
    id: `openai:${model}`,
    async embed(texts: string[]): Promise<AestheticVector[]> {
      if (texts.length === 0) return []
      const apiKey = getApiKey()
      if (!apiKey) {
        throw new Error('OpenAiEmbeddingProvider: no OpenAI API key resolved (set OPENAI_API_KEY or pass apiKey)')
      }
      const { default: OpenAI } = await import('openai')
      const client = new OpenAI({ apiKey })
      const res = await client.embeddings.create({ model, input: texts })
      const out = new Array<AestheticVector>(texts.length)
      for (const item of res.data) out[item.index] = l2normalize(item.embedding)
      return out
    },
  }
}

/**
 * The default network-backed provider. Reads `OPENAI_API_KEY` from the
 * environment lazily on each `embed` call via the shared provider abstraction.
 */
export const OpenAiEmbeddingProvider: EmbeddingProvider = createOpenAiProvider(DEFAULT_OPENAI_EMBEDDING_MODEL, () =>
  resolveProviderApiKey('openai'),
)

/** Options for selecting an embedding provider. */
export interface ResolveEmbeddingOptions {
  /** Explicit key, bypassing env resolution. */
  apiKey?: string
  /** Env to resolve the key from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  /** Override the embedding model (otherwise `DEFAULT_OPENAI_EMBEDDING_MODEL`). */
  model?: string
}

/**
 * Pick a concrete embedder: the OpenAI provider when a key is resolvable, else the
 * deterministic `HashEmbeddingProvider`. Fail-safe by construction — a missing key
 * yields a working offline embedder rather than an error.
 */
export function resolveEmbeddingProvider(opts: ResolveEmbeddingOptions = {}): EmbeddingProvider {
  const apiKey = resolveProviderApiKey('openai', opts.apiKey, opts.env)
  if (!apiKey) return HashEmbeddingProvider
  const model = opts.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL
  if (model === DEFAULT_OPENAI_EMBEDDING_MODEL && opts.apiKey === undefined && opts.env === undefined) {
    return OpenAiEmbeddingProvider
  }
  return createOpenAiProvider(model, () => resolveProviderApiKey('openai', opts.apiKey, opts.env))
}
