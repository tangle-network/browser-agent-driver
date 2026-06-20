/**
 * Corpus authoring — reverse-engineer an `Exemplar` from a live page, and ingest a
 * batch into a corpus. This is the OFFLINE authoring path (never the audit hot
 * path) and the ONLY consumer of the `CorpusWriter` half of the store.
 *
 * Every browser/LLM/IO dependency is INJECTED through the narrow contract
 * interfaces, so the whole module unit-tests with no live browser, model, or
 * network:
 *  - `DesignDnaExtractor` turns a URL into a `DnaCapture` (the shipped adapter
 *    reuses `extractDesignTokens` → `toDesignDNA`; tests inject a fake);
 *  - `EmbeddingProvider` embeds the `aestheticDescriptor` into the retrieval
 *    vector (the deterministic `HashEmbeddingProvider` is the offline default);
 *  - `ExemplarClassifier` supplies `pageType` + `jobToBeDone` when they aren't
 *    authored by hand (the shipped wiring backs it with `classifyEnsemble`).
 *
 * Nothing here fabricates a page type: an exemplar's `pageType`/`jobToBeDone` must
 * be authored explicitly OR produced by an injected classifier, otherwise the
 * build fails closed.
 */

import { promises as fs } from 'node:fs'
import type {
  DesignDnaExtractor,
  DesignDNA,
  DesignTokens,
  EmbeddingProvider,
  Exemplar,
  ExemplarSource,
  CorpusWriter,
  MeasurementBundle,
  PageType,
} from '../contracts.js'
import { aestheticDescriptor } from '../dna/descriptor.js'

/**
 * Seed taste rating for a freshly-authored exemplar, before any pairwise vote
 * moves it. Matches `judge/rank.ts`'s `ELO_START` so corpus seeds and ranked
 * directions live on one rating scale.
 */
export const SEED_ELO = 1500

/** Page-typing input handed to an injected classifier. */
export interface ExemplarClassifyInput {
  url: string
  dna: DesignDNA
  tokens: DesignTokens
}

/** What an injected classifier must return — the two retrieval-keying fields. */
export interface ExemplarClassification {
  pageType: PageType
  jobToBeDone: string
}

/**
 * Narrow classification boundary: derive `pageType` + `jobToBeDone` from a
 * captured page. Injected so the heavyweight `classifyEnsemble` (Brain + browser)
 * stays out of this pure-by-injection module and tests pass a stub.
 */
export interface ExemplarClassifier {
  classify(input: ExemplarClassifyInput): Promise<ExemplarClassification>
}

/** Options for authoring ONE exemplar. Deps are injected alongside the target. */
export interface BuildExemplarOptions {
  url: string
  extractor: DesignDnaExtractor
  embedder: EmbeddingProvider
  /** Required unless BOTH `pageType` and `jobToBeDone` are authored explicitly. */
  classifier?: ExemplarClassifier
  /** Provenance label; defaults to `'manual'`. */
  source?: ExemplarSource
  /** Hand-authored page type (skips the classifier for this field). */
  pageType?: PageType
  /** Hand-authored job-to-be-done (skips the classifier for this field). */
  jobToBeDone?: string
  /** Seed taste rating; defaults to `SEED_ELO`. */
  eloRating?: number
  outputDir?: string
  headless?: boolean
  /** Deterministic measurements folded into the DNA signals, when available. */
  measurements?: MeasurementBundle
}

/** Lowercase, filename-safe slug; collapses runs of non-alphanumerics to `-`. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Stable id from source + url. URL targets key on host+path (query/hash dropped);
 * non-URL targets (a rip dir / file path) slugify raw. Deterministic and
 * filename-safe.
 */
export function exemplarId(source: ExemplarSource, url: string): string {
  let locus = url
  try {
    const u = new URL(url)
    locus = `${u.hostname}${u.pathname}`
  } catch {
    // Non-URL target — slugify the raw string.
  }
  return slugify(`${source}-${locus}`) || slugify(String(source)) || 'exemplar'
}

/** Prefer the desktop viewport screenshot; fall back to the first available. */
function pickScreenshot(paths: Record<string, string>): string {
  return paths['desktop'] ?? Object.values(paths)[0] ?? ''
}

/**
 * Reverse-engineer one `Exemplar` from a URL: extract → DNA, classify (or use the
 * authored type/job), embed the aesthetic descriptor, and assemble the row. Does
 * NOT persist — `ingestCorpus` owns the `CorpusWriter`. Fail-closed on a missing
 * classifier and on an empty embedding.
 */
export async function buildExemplar(opts: BuildExemplarOptions): Promise<Exemplar> {
  const source: ExemplarSource = opts.source ?? 'manual'
  const capture = await opts.extractor.extract({
    url: opts.url,
    headless: opts.headless,
    outputDir: opts.outputDir,
    measurements: opts.measurements,
  })

  let pageType: PageType
  let jobToBeDone: string
  if (opts.pageType !== undefined && opts.jobToBeDone !== undefined) {
    pageType = opts.pageType
    jobToBeDone = opts.jobToBeDone
  } else {
    if (!opts.classifier) {
      throw new Error(
        'buildExemplar: provide both pageType and jobToBeDone, or inject a classifier — page type is never fabricated',
      )
    }
    const classified = await opts.classifier.classify({ url: opts.url, dna: capture.dna, tokens: capture.tokens })
    pageType = opts.pageType ?? classified.pageType
    jobToBeDone = opts.jobToBeDone ?? classified.jobToBeDone
  }

  const descriptor = aestheticDescriptor(capture.dna)
  const [aestheticVector] = await opts.embedder.embed([descriptor])
  if (!aestheticVector || aestheticVector.length === 0) {
    throw new Error('buildExemplar: embedder returned no vector for the aesthetic descriptor')
  }

  return {
    id: exemplarId(source, opts.url),
    source,
    url: opts.url,
    pageType,
    jobToBeDone,
    dna: capture.dna,
    screenshotPath: pickScreenshot(capture.screenshotPaths),
    aestheticVector,
    eloRating: opts.eloRating ?? SEED_ELO,
  }
}

/** One target page to ingest; per-target fields override the shared `ingestCorpus` deps. */
export interface IngestTarget {
  url: string
  source?: ExemplarSource
  pageType?: PageType
  jobToBeDone?: string
  eloRating?: number
  outputDir?: string
  headless?: boolean
  measurements?: MeasurementBundle
}

/** Shared deps + targets for a batch ingest. */
export interface IngestCorpusOptions {
  targets: IngestTarget[]
  /** The corpus authoring sink — the only `CorpusWriter` use in the engine. */
  store: CorpusWriter
  extractor: DesignDnaExtractor
  embedder: EmbeddingProvider
  classifier?: ExemplarClassifier
  /** Default source for targets that don't set one. */
  source?: ExemplarSource
}

/** Outcome of a batch ingest: ids added + per-target failures (never throws on one bad target). */
export interface IngestResult {
  added: string[]
  failed: { url: string; reason: string }[]
}

/**
 * Relocate a freshly-captured screenshot into the corpus via `saveScreenshot`,
 * returning the corpus-relative path to store. Returns `undefined` when there is
 * no readable source screenshot (a missing screenshot is non-fatal — the DNA and
 * vector are the load-bearing parts of an exemplar).
 */
async function relocateScreenshot(store: CorpusWriter, id: string, srcPath: string): Promise<string | undefined> {
  if (!srcPath) return undefined
  let png: Buffer
  try {
    png = await fs.readFile(srcPath)
  } catch {
    return undefined
  }
  return store.saveScreenshot(id, png)
}

/**
 * Author a batch of exemplars into the corpus. Each target is built, its
 * screenshot relocated into the corpus, and the row upserted; a failure on one
 * target is captured in `failed` and never aborts the rest.
 */
export async function ingestCorpus(opts: IngestCorpusOptions): Promise<IngestResult> {
  const added: string[] = []
  const failed: { url: string; reason: string }[] = []

  for (const target of opts.targets) {
    try {
      const exemplar = await buildExemplar({
        url: target.url,
        extractor: opts.extractor,
        embedder: opts.embedder,
        classifier: opts.classifier,
        source: target.source ?? opts.source,
        pageType: target.pageType,
        jobToBeDone: target.jobToBeDone,
        eloRating: target.eloRating,
        outputDir: target.outputDir,
        headless: target.headless,
        measurements: target.measurements,
      })
      const relocated = await relocateScreenshot(opts.store, exemplar.id, exemplar.screenshotPath)
      const persisted = relocated !== undefined ? { ...exemplar, screenshotPath: relocated } : exemplar
      await opts.store.upsert(persisted)
      added.push(persisted.id)
    } catch (err) {
      failed.push({ url: target.url, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { added, failed }
}
