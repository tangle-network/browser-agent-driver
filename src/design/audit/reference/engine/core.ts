/**
 * The single reference-grounded sequencer — ORCH, no domain logic of its own.
 *
 * `runRedesignCore` threads one page through the locked data flow (ARCHITECTURE
 * §2): extract DNA → embed → retrieve → guard → generate → judge (absolute
 * quality + relative direction legs) → rank → score → assemble artifact →
 * project findings. EVERY decision is delegated to a pure core (`guard`,
 * `budget`, `score-core`, `artifact/*`, `judge/*`, `dna/*`) or an injected
 * boundary on `deps`; this file only orders the stages and shapes the inputs
 * each stage already expects. It imports NO concrete IO/LLM adapter — those are
 * supplied by `engine/wiring` at the composition root and arrive as the narrow
 * `ReferenceEngineDeps` interfaces.
 *
 * Fail-closed, never fake-success:
 *  - the `guard` aborts (throws its reason) when there is nothing to ground
 *    against, so an ungrounded run can never masquerade as reference-grounded;
 *  - a generator that yields zero directions throws rather than emitting an
 *    empty artifact;
 *  - `buildRedesignArtifact` throws on fabricated provenance.
 *
 * Acquire-once: the core retrieves against the pre-loaded `input.corpus` and
 * NEVER calls `store.load()` — loading the corpus once per run is the
 * entrypoint's job (it protects the ±0.5 reproducibility gate across pages/reps).
 */

import type {
  ReferenceEngineDeps,
  RedesignCoreInput,
  RedesignRunResult,
  RetrievalResult,
  CorpusQuery,
  GenerationContext,
  JudgeSubject,
  RedesignDirection,
  TasteVerdict,
  TasteJudge,
  QualityAssessment,
  Dimension,
  DesignDNA,
  Exemplar,
  ReferenceContext,
  PageClassification,
} from '../contracts.js'
import { summarizeDNA } from '../dna/derive.js'
import { aestheticDescriptor, structuralFeatures } from '../dna/descriptor.js'
import { dnaDelta } from '../dna/delta.js'
import { DEFAULT_RETRIEVE_WEIGHTS } from '../config.js'
import { DIMENSIONS } from '../../score-types.js'
import { planJudgeBudget, mapWithConcurrency } from './budget.js'
import { decideProceed } from './guard.js'
import { deriveHeadlineScore, toDimensionScores, toDesignSystemScore } from './score-core.js'
import { assessPageQuality } from '../judge/quality.js'
import { judgePair } from '../judge/pairwise.js'
import { buildRedesignArtifact } from '../artifact/build.js'
import { directionToFindings } from '../artifact/to-findings.js'

// Stable id + seed rating for the synthetic exemplar minted from an operator
// `--reference`. The reference "stands in for (or augments) corpus retrieval"
// (contracts `ReferenceContext`): wrapping it as a `RetrievalResult` lets the
// generator ground in it, the absolute quality leg compare against it, and the
// artifact cite it — through the SAME shapes the corpus path already uses, so no
// stage needs a reference-only code branch. `1500` mirrors the corpus seed elo
// (corpus/build.SEED_ELO) without importing that L2 adapter into the core.
const REFERENCE_EXEMPLAR_ID = 'reference'
const REFERENCE_SEED_ELO = 1500
// Budget for the direction subject's spec dump fed to the judge.
const DIRECTION_SUMMARY_MAX_CHARS = 1200

/**
 * Run one page through the reference-grounded engine. Pure-ish: every impure
 * boundary (browser extract, embed, LLM generate/judge, corpus disk) is reached
 * only through the injected `deps`, so the whole sequencer unit-tests with fakes.
 */
export async function runRedesignCore(
  deps: ReferenceEngineDeps,
  input: RedesignCoreInput,
): Promise<RedesignRunResult> {
  const { config } = input

  // Token accounting: the only LLM token signal the injected contracts surface
  // is `RawVerdict.tokensUsed` on the judge boundary (the `RedesignGenerator`
  // contract returns no per-call tokens). Wrap the judge once so every debias /
  // quality call funnels its tokens into one honest counter — generation tokens
  // are simply not observable here, never fabricated to look complete.
  let judgeTokens = 0
  const judge: TasteJudge = {
    id: deps.judge.id,
    async compare(judgeInput) {
      const verdict = await deps.judge.compare(judgeInput)
      judgeTokens += verdict.tokensUsed ?? 0
      return verdict
    },
  }

  // 1. Page → DesignDNA (folds in the already-gathered measurement signals).
  const { dna } = await deps.extractor.extract({ url: input.url, measurements: input.measurements })

  // 2. DNA → authoritative aesthetic vector (embedded ONCE) + structural vector.
  const vectors = await deps.embedder.embed([aestheticDescriptor(dna)])
  const aestheticVector = vectors[0] ?? []
  const query: CorpusQuery = {
    pageType: input.classification.type,
    jobToBeDone: input.classification.intent,
    aestheticVector,
    structuralVector: structuralFeatures(dna),
  }

  // 3. Retrieve k nearest exemplars; an operator reference is prepended as an
  //    always-included grounding signal that augments the corpus hits.
  const corpusHits = deps.matcher.retrieve(query, input.corpus, DEFAULT_RETRIEVE_WEIGHTS).slice(0, config.k)
  const hits: RetrievalResult[] = config.reference
    ? [referenceHit(config.reference, input.classification), ...corpusHits]
    : corpusHits

  // 4. Fail-closed gate: nothing to ground against ⇒ abort with the reason.
  const decision = decideProceed({
    corpusSize: input.corpus.length,
    retrieved: hits.length,
    ...(config.reference ? { reference: config.reference } : {}),
  })
  if (!decision.ok) throw new Error(decision.reason)

  // 5. Generate the grounded redesign directions (concurrent inside the adapter).
  const ctx: GenerationContext = {
    url: input.url,
    classification: input.classification,
    dna,
    measurements: input.measurements,
  }
  const directions = await deps.generator.generate(ctx, hits, { count: config.directionCount })
  if (directions.length === 0) {
    throw new Error(
      'reference engine: generator produced no redesign directions (all generation calls failed); ' +
        'refusing to emit an empty reference-grounded artifact',
    )
  }

  // Plan both judging legs from the ACTUAL direction count + retrieved exemplars.
  const plan = planJudgeBudget(directions.length, hits.length, config.budget, DIMENSIONS.length)
  const dimensions: Dimension[] = plan.qualityDimensions > 0 ? DIMENSIONS.slice(0, plan.qualityDimensions) : []

  // 6. Judge legs run with overlap: the absolute quality leg (page vs exemplars)
  //    and the relative direction-ranking leg are independent.
  const pageSubject: JudgeSubject = {
    id: 'page',
    dnaSummary: summarizeDNA(dna),
    ...(input.screenshotPath ? { screenshotPath: input.screenshotPath } : {}),
  }
  const exemplarSubjects = hits.map((hit) => exemplarSubject(hit, (e) => deps.store.resolveScreenshot(e)))
  // Bound the quality leg to the exemplar count the budget actually paid for
  // (qualityPairs already folds in the per-dimension expansion).
  const qualityExemplarCount = Math.floor(plan.qualityPairs / Math.max(1, plan.qualityDimensions))
  const qualityExemplars = exemplarSubjects.slice(0, Math.max(0, qualityExemplarCount))

  const [quality, verdicts] = await Promise.all([
    assessPageQuality(
      judge,
      pageSubject,
      qualityExemplars,
      dimensions.length > 0 ? { dimensions } : {},
    ),
    judgeDirectionLeg(judge, directions, plan.directionPairs, plan.reps, config.budget.concurrency, config.reference),
  ])

  // 7. Roll the relative verdicts up into a winner.
  const ranking = deps.ranker.rank(directions.map((d) => d.id), verdicts)

  // 8. Single scoring authority: every surface derives from `quality`.
  const headlineScore = deriveHeadlineScore(quality, input.measurements)
  const dimensionScores = toDimensionScores(quality)
  const designSystemScore = toDesignSystemScore(quality)

  // 9. Assemble the rich artifact (winner first) + project the v1 findings.
  const referenceId = config.reference ? REFERENCE_EXEMPLAR_ID : undefined
  const artifact = buildRedesignArtifact({
    url: input.url,
    directions,
    ranking,
    retrieval: hits,
    verdicts,
    tokensUsed: judgeTokens,
    ...(referenceId ? { referenceId } : {}),
  })

  const winner = artifact.directions[0]
  if (!winner) throw new Error('reference engine: ranking produced no winning direction')
  const gapTarget = resolveGapTarget(config.reference, winner, hits, dna)
  const findings = directionToFindings(winner, dnaDelta(dna, gapTarget), input.measurements, dna, hits)

  return {
    artifact,
    quality,
    headlineScore,
    dimensionScores,
    designSystemScore,
    findings,
    classification: input.classification,
    measurements: input.measurements,
    tokensUsed: judgeTokens,
  }
}

/**
 * The relative leg: judge unique direction pairs (bounded by the budget plan)
 * against the named reference, position-debiased, run with bounded concurrency.
 */
async function judgeDirectionLeg(
  judge: TasteJudge,
  directions: RedesignDirection[],
  maxPairs: number,
  reps: number,
  concurrency: number,
  reference: ReferenceContext | undefined,
): Promise<TasteVerdict[]> {
  const subjects = directions.map(directionSubject)
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < directions.length; i++) {
    for (let j = i + 1; j < directions.length; j++) pairs.push([i, j])
  }
  const planned = pairs.slice(0, Math.max(0, maxPairs))
  return mapWithConcurrency(planned, concurrency, ([i, j]) =>
    judgePair(
      judge,
      {
        a: subjects[i],
        b: subjects[j],
        ...(reference ? { reference } : {}),
      },
      reps,
    ),
  )
}

/**
 * A retrieved exemplar as a judge subject (DNA spec dump, optional screenshot).
 * The corpus stores `screenshotPath` RELATIVE to the corpus dir, so it is resolved
 * to an absolute path through the store before reaching a vision judge that reads
 * it off disk; the reference hit's already-absolute path passes through unchanged.
 * Byte-neutral for the text judge, which never reads the field.
 */
function exemplarSubject(hit: RetrievalResult, resolveScreenshot: (e: Exemplar) => string): JudgeSubject {
  const screenshotPath = resolveScreenshot(hit.exemplar)
  return {
    id: hit.exemplar.id,
    dnaSummary: summarizeDNA(hit.exemplar.dna),
    ...(screenshotPath ? { screenshotPath } : {}),
  }
}

/**
 * A generated direction as a judge subject: evocative headline + spec dump. NO
 * `screenshotPath` — directions are unrendered specs, so the direction-ranking
 * leg stays text-only (a vision judge falls back to text here). Future lever:
 * render each direction to a screenshot to make this leg vision-judgeable too.
 */
function directionSubject(direction: RedesignDirection): JudgeSubject {
  return {
    id: direction.id,
    directionSummary: `${direction.name} — ${direction.rationale}`,
    dnaSummary: summarizeDirectionSpec(direction),
  }
}

/**
 * A compact, budget-bounded summary of a direction's PROPOSED systems for the
 * judge. Renders the spec (type/colour/motion/hierarchy) the direction defines —
 * NOT an extracted DNA, which a not-yet-built redesign has none of.
 */
function summarizeDirectionSpec(d: RedesignDirection): string {
  const t = d.typeSystem
  const c = d.colorSystem
  const m = d.motionSpec
  const lines = [
    `type: families ${t.families.join(' ') || 'system'}; scale ${t.scalePx.join('/') || 'n/a'}px; ratio ~${t.ratio}×`,
    `colour: primary ${c.primary}${c.accent ? `, accent ${c.accent}` : ''}, background ${c.background}, neutrals ${c.neutrals.join(' ') || 'n/a'}`,
    `motion: ${m.durationsMs.join('/') || 'none'}ms ${m.easings.join(' ') || 'no-easing'}${m.cues.length ? `; ${m.cues.join('; ')}` : ''}`,
    `hierarchy: ${d.hierarchy.join(' → ') || 'n/a'}`,
  ]
  const body = lines.join('\n')
  return body.length > DIRECTION_SUMMARY_MAX_CHARS ? `${body.slice(0, DIRECTION_SUMMARY_MAX_CHARS - 1)}…` : body
}

/**
 * The DNA the winner is measured AGAINST when minting the gap findings. Prefers
 * the explicit operator reference, then the winner's first grounding exemplar,
 * then the top retrieved exemplar, and finally the page itself (a zero delta) so
 * a finding set is always produced rather than a crash.
 */
function resolveGapTarget(
  reference: ReferenceContext | undefined,
  winner: RedesignDirection,
  hits: RetrievalResult[],
  current: DesignDNA,
): DesignDNA {
  if (reference) return reference.dna
  const groundedId = winner.groundedInExemplarIds[0]
  const grounded = groundedId ? hits.find((h) => h.exemplar.id === groundedId) : undefined
  return grounded?.exemplar.dna ?? hits[0]?.exemplar.dna ?? current
}

/**
 * Wrap an operator reference as a synthetic `RetrievalResult` so it flows through
 * the same generate / judge / artifact stages as a corpus exemplar.
 */
function referenceHit(reference: ReferenceContext, classification: PageClassification): RetrievalResult {
  const exemplar: Exemplar = {
    id: REFERENCE_EXEMPLAR_ID,
    source: 'manual',
    url: reference.dna.url,
    pageType: classification.type,
    jobToBeDone: classification.intent,
    dna: reference.dna,
    screenshotPath: reference.screenshotPath ?? '',
    aestheticVector: [],
    eloRating: REFERENCE_SEED_ELO,
  }
  return { exemplar, score: 1, reasons: [`operator reference (${reference.kind})`] }
}
