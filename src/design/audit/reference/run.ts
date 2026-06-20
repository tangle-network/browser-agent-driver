/**
 * L4 entrypoint — the rich library/CLI entry returning the first-class
 * `RedesignArtifact`. ORCH: it composes the default wiring, runs the ONE shared
 * core, and shapes nothing of its own.
 *
 * Responsibilities (and only these):
 *  - resolve the config once (operator overrides + the already-resolved
 *    `reference` folded into `config.reference`, the single field the core reads);
 *  - build the dependency bundle through `engine/wiring.buildDefaultDeps`, unless
 *    the caller injects its own `deps` (tests pass deterministic fakes — no live
 *    model, browser, or corpus disk);
 *  - acquire-once: load the corpus a SINGLE time per run via `deps.store.load()`
 *    (overridable by `corpus`) and thread it into the core, so a caller looping
 *    pages never re-reads it — the reproducibility discipline the core relies on;
 *  - stream accepted directions through `onDirection` by decorating the generator
 *    dep (the core sequences and does not forward streaming hooks);
 *  - write the artifact when `config.artifactDir` is set, then return it.
 *
 * Classification + deterministic measurements are produced by the existing v1
 * stages UPSTREAM (`classifyEnsemble` / `gatherMeasurements`) and passed in. When
 * a caller omits them this entry falls back to an honest "unknown / nothing
 * measured" pair — never fabricated passing data — so retrieval fails closed in
 * the guard (no exemplars of an unknown type, no reference) rather than grounding
 * against a guessed page archetype.
 */

import type {
  RedesignArtifact,
  RedesignDirection,
  RedesignGenerator,
  ReferenceEngineDeps,
  ReferenceContext,
  PageClassification,
  MeasurementBundle,
  Exemplar,
} from './contracts.js'
import { runRedesignCore } from './engine/core.js'
import { buildDefaultDeps, type ReferenceBrain } from './engine/wiring.js'
import { resolveReferenceConfig, type ReferenceConfigOverrides } from './config.js'
import { writeArtifact } from './artifact/render.js'

/**
 * Options for {@link runReferenceRedesign}. `url` + `brain` are the only required
 * inputs; everything else is an override the upstream pipeline (or a test) supplies.
 */
export interface RunReferenceRedesignOptions {
  url: string
  /** Text model seam, satisfied structurally by the real `Brain`. */
  brain: ReferenceBrain
  /** Operator overrides merged onto the frozen defaults. */
  config?: ReferenceConfigOverrides
  /** Reference resolved ONCE upstream; folded into `config.reference` here. */
  reference?: ReferenceContext
  /** Upstream page classification; an honest `unknown` placeholder when omitted. */
  classification?: PageClassification
  /** Upstream deterministic measurements; an honest "nothing measured" bundle when omitted. */
  measurements?: MeasurementBundle
  /** Page screenshot for a future vision judge (text judge ignores it). */
  screenshotPath?: string
  /** Fires once per accepted direction as generation streams. */
  onDirection?: (direction: RedesignDirection) => void
  /** Pre-built deps; defaults to `buildDefaultDeps(brain, config)`. Tests inject fakes. */
  deps?: ReferenceEngineDeps
  /** Pre-loaded corpus; defaults to a single `deps.store.load()` per run. */
  corpus?: Exemplar[]
}

/**
 * Run one page through the reference-grounded engine and return the rich
 * `RedesignArtifact` (winner-first directions, ranking, grounding provenance).
 */
export async function runReferenceRedesign(
  opts: RunReferenceRedesignOptions,
): Promise<RedesignArtifact> {
  const config = resolveReferenceConfig({
    ...opts.config,
    ...(opts.reference ? { reference: opts.reference } : {}),
  })

  const baseDeps = opts.deps ?? buildDefaultDeps(opts.brain, config)
  const deps = opts.onDirection ? withDirectionStream(baseDeps, opts.onDirection) : baseDeps

  // Acquire-once: a single corpus read per run, reused across the caller's pages.
  const corpus = opts.corpus ?? (await deps.store.load())

  const result = await runRedesignCore(deps, {
    url: opts.url,
    classification: opts.classification ?? neutralClassification(),
    measurements: opts.measurements ?? unmeasuredBundle(),
    ...(opts.screenshotPath ? { screenshotPath: opts.screenshotPath } : {}),
    corpus,
    config,
  })

  if (config.artifactDir) await writeArtifact(result.artifact, config.artifactDir)
  return result.artifact
}

/**
 * Decorate the generator boundary so the caller's `onDirection` is injected into
 * the core's generation call. The core invokes `generate(ctx, hits, { count })`
 * with no streaming hook by design; composing the callback here keeps the core a
 * pure sequencer while still surfacing each accepted direction as it lands.
 */
function withDirectionStream(
  deps: ReferenceEngineDeps,
  onDirection: (direction: RedesignDirection) => void,
): ReferenceEngineDeps {
  const generator: RedesignGenerator = {
    generate: (ctx, exemplars, genOpts) =>
      deps.generator.generate(ctx, exemplars, { ...genOpts, onDirection }),
  }
  return { ...deps, generator }
}

/**
 * The honest "no upstream classification" fallback. Only `type` (the retrieval
 * hard filter) and `intent` (the low-weight job signal) are consumed by the
 * engine, so the remaining fields are inert placeholders; `type: 'unknown'` with
 * `confidence: 0` makes the absence explicit and lets the guard abort rather than
 * grounding against a guessed archetype.
 */
function neutralClassification(): PageClassification {
  return {
    type: 'unknown',
    domain: 'unknown',
    framework: null,
    designSystem: 'unknown',
    maturity: 'shipped',
    intent: '',
    confidence: 0,
  }
}

/**
 * The honest "no measurements gathered" fallback — NOT "everything passed". No
 * failures are reported because nothing ran (`a11y.ran: false`, contrast
 * `totalChecked: 0`), mirroring `gatherMeasurements`' own catch-fallback shape, so
 * the DNA folds in absent signals and the headline floor never trips on
 * fabricated pass data.
 */
function unmeasuredBundle(): MeasurementBundle {
  return {
    contrast: { totalChecked: 0, aaFailures: [], aaaFailures: [], summary: { aaPassRate: 1, aaaPassRate: 1 } },
    a11y: { ran: false, violations: [], passes: 0 },
    hasBlockingIssues: false,
  }
}
