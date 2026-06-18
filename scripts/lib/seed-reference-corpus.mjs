/**
 * Pure-logic helpers for scripts/seed-reference-corpus.mjs. Extracted so the
 * arg/source parsing and the classifier adapter unit-test without a live
 * browser, model, or network — every heavyweight dep stays injected.
 *
 * Three units:
 *  - parseSeedArgs(argv)       → { urls[], file?, corpusDir?, provider?, model?, apiKey?, source?, help }
 *  - parseSourcesFile(text)    → the raw JSON array (string[] | object[]) of a --file
 *  - toIngestTargets({urls,sources}) → deduped IngestTarget[] for ingestCorpus
 *  - makeEnsembleClassifier({classifyEnsemble, brain}) → ExemplarClassifier backed by classifyEnsemble
 *
 * Nothing here imports dist/ — the executable script wires the real deps and
 * passes them in.
 */

/** CLI flags that consume the following argv token as their value. */
const VALUE_FLAGS = new Set(['file', 'corpus-dir', 'provider', 'model', 'api-key', 'source', 'embedder'])

/** kebab-case flag → camelCase option key. */
function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

/**
 * Parse the seed CLI: positional args are URLs; the rest are `--flag value`
 * pairs (or `--help`). Throws on an unknown flag or a value flag with no value,
 * so a typo never silently drops a target.
 */
export function parseSeedArgs(argv) {
  const opts = { urls: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      opts.help = true
      continue
    }
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (!VALUE_FLAGS.has(name)) {
        throw new Error(`seed: unknown flag --${name}`)
      }
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`seed: --${name} requires a value`)
      }
      opts[camel(name)] = value
      i++
      continue
    }
    opts.urls.push(a)
  }
  return opts
}

/**
 * Parse a `--file` sources document: a JSON array whose entries are either URL
 * strings or `IngestTarget` objects (so per-URL pageType/jobToBeDone can be
 * authored, letting buildExemplar skip the classifier). Fail-closed on
 * non-JSON or a non-array root.
 */
export function parseSourcesFile(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`seed: sources file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(data)) {
    throw new Error('seed: sources file must be a JSON array of URL strings or target objects')
  }
  return data
}

function normalizeTarget(entry, origin) {
  if (typeof entry === 'string') {
    const url = entry.trim()
    if (!url) throw new Error(`seed: empty URL in ${origin} sources`)
    return { url, headless: true }
  }
  if (entry && typeof entry === 'object' && typeof entry.url === 'string' && entry.url.trim()) {
    // Author-supplied fields (pageType/jobToBeDone/eloRating/source) flow through;
    // headless defaults true but an explicit per-target value still wins.
    return { headless: true, ...entry, url: entry.url.trim() }
  }
  throw new Error(`seed: invalid ${origin} source entry: ${JSON.stringify(entry)}`)
}

/**
 * Combine positional URLs and `--file` sources into a deduped `IngestTarget[]`
 * (first occurrence of a URL wins). Throws on an empty or malformed entry.
 */
export function toIngestTargets({ urls = [], sources = [] }) {
  const targets = []
  const seen = new Set()
  const push = (entry, origin) => {
    const t = normalizeTarget(entry, origin)
    if (seen.has(t.url)) return
    seen.add(t.url)
    targets.push(t)
  }
  for (const u of urls) push(u, 'cli')
  for (const s of sources) push(s, 'file')
  return targets
}

/** jobToBeDone of last resort when the classifier returns an empty intent. */
export function jobToBeDoneFallback(url) {
  try {
    return `use ${new URL(url).hostname}`
  } catch {
    return 'use this page'
  }
}

/**
 * Adapt `classifyEnsemble` to the `ExemplarClassifier` boundary that
 * `ingestCorpus`/`buildExemplar` expect. The classify input carries no
 * PageState (corpus authoring has only url+dna+tokens), so a minimal
 * `{ url, title:'', snapshot:'' }` state is synthesised — the URL-pattern and
 * text-only LLM signals carry the vote; vision/DOM heuristics stay dormant.
 * Maps `{ type, intent }` → `{ pageType, jobToBeDone }` with a hostname fallback.
 */
export function makeEnsembleClassifier({ classifyEnsemble, brain }) {
  if (typeof classifyEnsemble !== 'function') {
    throw new Error('makeEnsembleClassifier: classifyEnsemble must be a function')
  }
  if (!brain) throw new Error('makeEnsembleClassifier: brain is required')
  return {
    async classify({ url }) {
      const state = { url, title: '', snapshot: '' }
      const c = await classifyEnsemble({ brain, state, url })
      const pageType = c?.type ?? 'unknown'
      const intent = typeof c?.intent === 'string' ? c.intent.trim() : ''
      return { pageType, jobToBeDone: intent || jobToBeDoneFallback(url) }
    },
  }
}
