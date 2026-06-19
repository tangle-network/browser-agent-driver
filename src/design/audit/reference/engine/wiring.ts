/**
 * Composition root — the ONE place concrete adapters meet. ORCH, zero domain
 * logic.
 *
 * `buildDefaultDeps` assembles the `ReferenceEngineDeps` bundle `engine/core`
 * depends on, picking each concrete implementation of the seven narrow boundary
 * interfaces: the page→DNA extractor, the file corpus store (exposed as its
 * read-only half), the embedding provider, the pure matcher, the brain-backed
 * generator, the default text judge, and the pure ranker. The core never sees a
 * concrete — it receives only these interfaces — and this module never imports
 * `engine/core`, so the two L3 siblings have no edge between them.
 *
 * The model is injected through the narrow `ReferenceBrain` seam (exactly
 * `brain.complete`'s shape, shared by the generator + judge adapters). The real
 * `Brain` satisfies it structurally, so the L4 entrypoints pass `brain`
 * unchanged while tests inject a deterministic stub with no live model.
 */

import type {
  ReferenceEngineDeps,
  ReferenceGroundedConfig,
  ExemplarMatcher,
  DirectionRanker,
  EmbeddingProvider,
  TasteJudge,
} from '../contracts.js'
import { createPageDnaExtractor } from '../dna/page-adapter.js'
import { createFileCorpusStore } from '../corpus/store.js'
import { resolveEmbeddingProvider } from '../retrieval/embedding-openai.js'
import { HashEmbeddingProvider } from '../retrieval/embedding-hash.js'
import { retrieve } from '../retrieval/matcher.js'
import { createBrainGenerator, type GenerationModel } from '../generate/generator.js'
import { createTextJudge, type JudgeModel } from '../judge/text-judge.js'
import { createVisionJudge } from '../judge/vision-judge.js'
import { buildVisionModels } from '../judge/vision-model.js'
import { rankDirections } from '../judge/rank.js'

/**
 * The model seam the default wiring needs. The generator and the default text
 * judge both reduce to `brain.complete`, so a single narrow interface satisfies
 * both adapters; the concrete `Brain` is assignable to it.
 */
export interface ReferenceBrain extends GenerationModel, JudgeModel {}

/**
 * Pick the concrete embedding provider for the config:
 *  - `'deterministic'` → the literally-pure offline hash embedder (zero network);
 *  - `'provider'`      → the network provider when a key resolves, else the hash
 *    embedder (fail-safe: a missing key yields a working offline run, not an error).
 */
function selectEmbedder(config: ReferenceGroundedConfig): EmbeddingProvider {
  return config.embedder === 'provider' ? resolveEmbeddingProvider() : HashEmbeddingProvider
}

/**
 * Pick the concrete taste judge. `'text'` is the shipped default (judges from DNA
 * summaries via `brain.complete`). `'vision'` builds the screenshot-grounded
 * ensemble from `config.visionModels`: ONE Brain per `{ provider, model }` ref
 * (each with its own provider key, constructed in `buildVisionModels`), wrapped
 * in the pure `createVisionJudge`. The injected text `brain` is reused as the
 * fallback for screenshot-less subjects (the direction-ranking leg), so the
 * vision judge stays a single drop-in for both legs. Fails closed: an empty
 * `visionModels` list throws rather than silently degrading to text.
 *
 * This is the composition root, so constructing concrete vision Brains here is by
 * design — the engine core only ever sees the narrow `TasteJudge`. Unit tests
 * inject `deps.judge` (or call `createVisionJudge` with stub models) and never
 * reach this Brain construction.
 */
function selectJudge(brain: ReferenceBrain, config: ReferenceGroundedConfig): TasteJudge {
  if (config.judge !== 'vision') return createTextJudge(brain)
  const refs = config.visionModels ?? []
  if (refs.length === 0) {
    throw new Error(
      'reference engine: judge "vision" requires at least one visionModels ref — none resolved',
    )
  }
  return createVisionJudge(buildVisionModels(refs), { textFallback: createTextJudge(brain) })
}

/**
 * Assemble the default dependency bundle for {@link runRedesignCore}. The corpus
 * store is created here but only its `CorpusReader` half reaches the core
 * (`ReferenceEngineDeps.store` is typed `CorpusReader`), so the audit hot path
 * can never touch the authoring mutators.
 */
export function buildDefaultDeps(
  brain: ReferenceBrain,
  config: ReferenceGroundedConfig,
): ReferenceEngineDeps {
  const matcher: ExemplarMatcher = { retrieve }
  const ranker: DirectionRanker = { rank: rankDirections }

  return {
    extractor: createPageDnaExtractor(),
    store: createFileCorpusStore(config.corpusDir),
    embedder: selectEmbedder(config),
    matcher,
    generator: createBrainGenerator(brain, { count: config.directionCount }),
    judge: selectJudge(brain, config),
    ranker,
  }
}
