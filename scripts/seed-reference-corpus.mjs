#!/usr/bin/env node
/**
 * Seed the reference-grounded design-audit corpus from a list of URLs.
 *
 * Drives the EXPORTED `ingestCorpus` with the real shipped deps:
 *   - createPageDnaExtractor()  — extract → DesignDNA over a live (headless) page
 *   - resolveEmbeddingProvider()— OpenAI text-embedding-3-small (fail-closed)
 *   - classifyEnsemble (wrapped) — URL + text-LLM page-type / job-to-be-done
 * and writes each exemplar through createFileCorpusStore.
 *
 * Per-URL failures are captured by ingestCorpus and NEVER abort the batch; the
 * script prints `added` and `failed` and exits non-zero only when a target
 * failed (or none were seeded).
 *
 * The corpus MUST be embedded with the same OpenAI model the audit retrieval
 * path uses, so this fails closed when no OpenAI key resolves rather than
 * silently seeding a hash-embedded (mismatched) corpus.
 *
 * Usage:
 *   # positional URLs
 *   node scripts/seed-reference-corpus.mjs https://stripe.com https://figma.com
 *
 *   # JSON file (array of URL strings OR IngestTarget objects with pageType/jobToBeDone)
 *   node scripts/seed-reference-corpus.mjs --file bench/design/reference-corpus/sources.example.json
 *
 * Flags:
 *   --file <path>        JSON array of URL strings or { url, pageType?, jobToBeDone?, ... }
 *   --corpus-dir <dir>   override the corpus dir (default: bench/design/reference-corpus)
 *   --provider <name>    LLM provider for the classifier brain (default: auto from env)
 *   --model <name>       classifier model (default: provider default, gpt-5.4 for openai)
 *   --api-key <key>      explicit key for an --provider openai classifier brain
 *   --source <label>     provenance label stamped on each exemplar (default: manual)
 *
 * Env: OPENAI_API_KEY is required (read from shell or .env/.env.local).
 *
 * Exit codes: 0 = all targets added; 1 = a target failed or nothing was seeded;
 * 2 = no targets / bad arguments.
 */

import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadLocalEnvFiles } from './lib/env-loader.mjs'
import {
  parseSeedArgs,
  parseSourcesFile,
  toIngestTargets,
  makeEnsembleClassifier,
} from './lib/seed-reference-corpus.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  let opts
  try {
    opts = parseSeedArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }

  if (opts.help) {
    printUsage()
    process.exit(0)
  }

  loadLocalEnvFiles(rootDir)

  // Assemble targets from positional URLs + an optional --file.
  let sources = []
  if (opts.file) {
    const filePath = path.resolve(opts.file)
    let text
    try {
      text = await fsp.readFile(filePath, 'utf-8')
    } catch (err) {
      console.error(`seed: cannot read --file ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    }
    sources = parseSourcesFile(text)
  }

  let targets
  try {
    targets = toIngestTargets({ urls: opts.urls, sources })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }

  if (targets.length === 0) {
    console.error('seed: no targets — pass URLs positionally or via --file <json>')
    printUsage()
    process.exit(2)
  }

  // Resolve provider/model/key for the classifier brain (real deps from dist).
  const { resolveDefaultProvider, resolveProviderModelName, resolveProviderApiKey } = await import(
    '../dist/provider-defaults.js'
  )
  const provider = opts.provider ?? resolveDefaultProvider()
  const model = resolveProviderModelName(provider, opts.model)
  const brainKey = opts.apiKey ?? resolveProviderApiKey(provider)

  // The embedder MUST match the audit retrieval path. The audit defaults to the
  // offline hash embedder (engine/wiring `selectEmbedder`), so seeding defaults
  // to hash too — identical vectors, no key, no dimension mismatch. Opt into
  // OpenAI embeddings with `--embedder provider`; then BOTH sides must run OpenAI
  // (audit with config.embedder='provider'), else cosine fail-closes to 0.
  const embedderKind = opts.embedder ?? 'deterministic'
  if (embedderKind !== 'deterministic' && embedderKind !== 'provider') {
    console.error("seed: --embedder must be 'deterministic' (hash, default) or 'provider' (OpenAI)")
    process.exit(2)
  }
  let openaiKey
  if (embedderKind === 'provider') {
    openaiKey = resolveProviderApiKey('openai', provider === 'openai' ? opts.apiKey : undefined)
    if (!openaiKey) {
      console.error(
        'seed: --embedder provider needs an OpenAI key — set OPENAI_API_KEY (or --api-key <key>). ' +
          'Omit --embedder to seed with the offline hash embedder that matches the audit default.',
      )
      process.exit(1)
    }
  }

  const { ingestCorpus, createFileCorpusStore, DEFAULT_REFERENCE_CONFIG } = await import(
    '../dist/design/audit/reference/index.js'
  )
  const { createPageDnaExtractor } = await import('../dist/design/audit/reference/dna/page-adapter.js')
  const { resolveEmbeddingProvider } = await import('../dist/design/audit/reference/retrieval/embedding-openai.js')
  const { HashEmbeddingProvider } = await import('../dist/design/audit/reference/retrieval/embedding-hash.js')
  const { classifyEnsemble } = await import('../dist/design/audit/classify-ensemble.js')
  const { Brain } = await import('../dist/brain/index.js')

  const brain = new Brain({
    provider,
    model,
    apiKey: brainKey,
    baseUrl: process.env.LLM_BASE_URL,
    vision: true,
    llmTimeoutMs: 120_000,
  })
  const extractor = createPageDnaExtractor()
  const embedder = embedderKind === 'provider' ? resolveEmbeddingProvider({ apiKey: openaiKey }) : HashEmbeddingProvider
  const classifier = makeEnsembleClassifier({ classifyEnsemble, brain })
  const corpusDir = opts.corpusDir ?? DEFAULT_REFERENCE_CONFIG.corpusDir
  const store = createFileCorpusStore(corpusDir)
  const source = opts.source ?? 'manual'

  const embedderLabel = embedderKind === 'provider' ? 'text-embedding-3-small' : `${embedder.id} (offline hash)`
  console.log(`seed: ${targets.length} target${targets.length === 1 ? '' : 's'} → ${corpusDir}`)
  console.log(`seed: classifier ${provider} · ${model} · embedder ${embedderLabel}`)

  const { added, failed } = await ingestCorpus({ targets, store, extractor, embedder, classifier, source })

  console.log(`\nadded ${added.length}:`)
  for (const id of added) console.log(`  ✓ ${id}`)
  if (failed.length > 0) {
    console.log(`\nfailed ${failed.length}:`)
    for (const f of failed) console.log(`  ✗ ${f.url} — ${f.reason}`)
  }

  process.exit(failed.length > 0 || added.length === 0 ? 1 : 0)
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/seed-reference-corpus.mjs [URL...] [--file <json>]',
      '',
      '  --file <path>        JSON array of URL strings or { url, pageType?, jobToBeDone? }',
      '  --corpus-dir <dir>   corpus dir (default: bench/design/reference-corpus)',
      '  --embedder <kind>    deterministic (hash, default, offline) | provider (OpenAI)',
      '  --provider <name>    classifier provider (default: auto from env)',
      '  --model <name>       classifier model (default: provider default)',
      '  --api-key <key>      explicit key for an openai classifier brain',
      '  --source <label>     exemplar provenance label (default: manual)',
      '',
      '  Default embedder is the offline hash (no key). --embedder provider needs OPENAI_API_KEY,',
      '  and the audit must then run config.embedder=provider so both sides match.',
    ].join('\n'),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
