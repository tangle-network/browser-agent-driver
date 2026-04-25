/**
 * Generic GEPA-style prompt evolution loop.
 *
 * Domain-agnostic. Callers supply:
 *   - A seed population of `PromptVariant`s.
 *   - A `score(variant, fixture, rep)` adapter that runs the variant against
 *     a fixture and returns a `TrialResult`.
 *   - A `mutate(parent, traces)` adapter that generates a child variant given
 *     a parent and the trace evidence (top + bottom trials) from the previous
 *     generation. Typically an LLM call.
 *
 * The loop manages population, parallel scheduling, Pareto selection, and
 * generation reporting. It does NOT know about design-audit, page screenshots,
 * or rubric fragments — those live in `targets.ts` and the runner script.
 *
 * This file is upstreamable to agent-eval as `prompt-evolution.ts` once the
 * shape stabilises; the only design-audit-specific surface is the imports.
 */

import { randomUUID } from 'node:crypto'
import type { FixtureCase, ObjectiveVector, PromptVariant, TrialResult, VariantSummary } from './types.js'
import { aggregateObjectiveVectors, mean, objectiveVectorFromTrials, stddev, weightedRecall, precision, passOrthogonality } from './metrics.js'
import { paretoFront, scalarScore, vectorFromSummary as _placeholder } from './pareto.js'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ignore = _placeholder
import { buildGenerationReport, vectorFromSummary, writeGenerationReport, type GenerationReport } from './scorecard.js'

export interface ScoreAdapter {
  /** Run the variant against the fixture for one repetition. */
  score(args: { variant: PromptVariant; fixture: FixtureCase; rep: number }): Promise<TrialResult>
}

export interface MutateAdapter {
  /**
   * Produce N children from a parent + trace evidence. The adapter decides
   * how many children to return — the loop will trim or pad to fit.
   */
  mutate(args: {
    parent: PromptVariant
    topTrials: TrialResult[]
    bottomTrials: TrialResult[]
    parentSummary: VariantSummary
    childCount: number
    generation: number
  }): Promise<PromptVariant[]>
}

export interface GepaConfig {
  runId: string
  target: PromptVariant['target']
  seedVariants: PromptVariant[]
  fixtures: FixtureCase[]
  reps: number
  generations: number
  populationSize: number
  /** Maximum concurrent score() calls. */
  scoreConcurrency: number
  scoreAdapter: ScoreAdapter
  mutateAdapter: MutateAdapter
  /** Where to write per-generation reports. */
  reportDir: string
  /** Optional progress hook so the runner can stream status. */
  onProgress?: (event: GepaProgressEvent) => void
  /** Stop early if a generation produces no Pareto-front improvement vs. the previous best. */
  earlyStopOnNoImprovement?: boolean
}

export type GepaProgressEvent =
  | { type: 'generation-start'; generation: number; populationSize: number }
  | { type: 'trial-complete'; generation: number; variantId: string; fixtureId: string; rep: number; ok: boolean; recall: number }
  | { type: 'generation-complete'; report: GenerationReport }
  | { type: 'converged'; generation: number; reason: string }

export interface GepaResult {
  runId: string
  target: PromptVariant['target']
  generations: GenerationReport[]
  bestVariant: PromptVariant
  bestVector: ObjectiveVector
  baselineVector: ObjectiveVector
}

export async function runGepaLoop(config: GepaConfig): Promise<GepaResult> {
  const generations: GenerationReport[] = []
  let population = [...config.seedVariants]
  let baseline: ObjectiveVector | null = null
  let baselineId: string | null = null
  let bestVariant: PromptVariant = population[0]!
  let bestVector: ObjectiveVector | null = null
  let allTrials: TrialResult[] = []

  for (let generation = 0; generation < config.generations; generation++) {
    config.onProgress?.({ type: 'generation-start', generation, populationSize: population.length })

    const trials = await scorePopulation(population, config, generation)
    allTrials = trials
    const summaries = summarisePopulation(population, config.fixtures, trials)

    if (!baseline || !baselineId) {
      const seedSummary = summaries.find((s) => s.variantId === population[0]!.id) ?? summaries[0]!
      baseline = vectorFromSummary(seedSummary)
      baselineId = seedSummary.variantId
    }

    const report = buildGenerationReport({
      runId: config.runId,
      target: config.target,
      generation,
      variants: population,
      summaries,
      baseline,
      baselineId,
    })
    writeGenerationReport(report, config.reportDir)
    generations.push(report)
    config.onProgress?.({ type: 'generation-complete', report })

    const winner = population.find((v) => v.id === report.winnerId) ?? population[0]!
    bestVariant = winner
    bestVector = report.bestVector

    // Convergence: no Pareto improvement compared to previous generation winner.
    if (config.earlyStopOnNoImprovement && generations.length >= 2) {
      const prev = generations[generations.length - 2]!
      const noChange = report.delta <= prev.delta && report.winnerId === prev.winnerId
      if (noChange) {
        config.onProgress?.({ type: 'converged', generation, reason: 'no improvement vs previous generation' })
        break
      }
    }

    if (generation === config.generations - 1) break

    population = await nextPopulation(population, summaries, allTrials, config, generation + 1)
  }

  return {
    runId: config.runId,
    target: config.target,
    generations,
    bestVariant,
    bestVector: bestVector ?? baseline!,
    baselineVector: baseline!,
  }
}

async function scorePopulation(
  population: PromptVariant[],
  config: GepaConfig,
  generation: number,
): Promise<TrialResult[]> {
  // Build the full job list — embarrassingly parallel. Concurrency-limited by config.
  const jobs: Array<() => Promise<TrialResult>> = []
  for (const variant of population) {
    for (const fixture of config.fixtures) {
      for (let rep = 0; rep < config.reps; rep++) {
        jobs.push(async () => {
          const result = await config.scoreAdapter.score({ variant, fixture, rep })
          config.onProgress?.({
            type: 'trial-complete',
            generation,
            variantId: variant.id,
            fixtureId: fixture.id,
            rep,
            ok: result.ok,
            recall: weightedRecall(fixture, result.goldenMatches),
          })
          return result
        })
      }
    }
  }
  return runWithConcurrency(jobs, config.scoreConcurrency)
}

async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  const limit = Math.max(1, concurrency)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= jobs.length) return
      results[i] = await jobs[i]!()
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}

function summarisePopulation(
  population: PromptVariant[],
  fixtures: FixtureCase[],
  trials: TrialResult[],
): VariantSummary[] {
  return population.map((variant) => {
    const variantTrials = trials.filter((t) => t.variantId === variant.id)
    const perFixture = fixtures.map((fixture) => {
      const fixTrials = variantTrials.filter((t) => t.fixtureId === fixture.id)
      const okTrials = fixTrials.filter((t) => t.ok)
      const scores = okTrials.map((t) => t.score)
      const costs = okTrials.map((t) => t.tokensUsed)
      const durations = okTrials.map((t) => t.durationMs)
      const recallVals = okTrials.map((t) => weightedRecall(fixture, t.goldenMatches))
      const precisionVals = okTrials.map((t) => precision(fixture, t.findings))
      const orthVals = okTrials
        .map((t) => (t.passFindings ? passOrthogonality(t.passFindings) : undefined))
        .filter((v): v is number => v !== undefined)
      return {
        variantId: variant.id,
        fixtureId: fixture.id,
        recall: mean(recallVals),
        precision: mean(precisionVals),
        meanScore: mean(scores),
        scoreStdDev: stddev(scores),
        meanCost: mean(costs),
        meanDurationMs: mean(durations),
        okRate: fixTrials.length === 0 ? 0 : okTrials.length / fixTrials.length,
        passOrthogonality: orthVals.length > 0 ? mean(orthVals) : undefined,
        trials: fixTrials.length,
      }
    })

    // Aggregate vectors per fixture, then average.
    const vectors = fixtures.map((fixture) => {
      const fixTrials = variantTrials.filter((t) => t.fixtureId === fixture.id)
      return objectiveVectorFromTrials(fixture, fixTrials)
    })
    const aggregate = aggregateObjectiveVectors(vectors)

    return {
      variantId: variant.id,
      recall: aggregate.recall,
      precision: aggregate.precision,
      meanScore: mean(perFixture.map((p) => p.meanScore)),
      meanCost: aggregate.cost,
      meanDurationMs: mean(perFixture.map((p) => p.meanDurationMs)),
      scoreStdDev: mean(perFixture.map((p) => p.scoreStdDev)),
      passOrthogonality: aggregate.passOrthogonality,
      fixtures: perFixture,
    }
  })
}

async function nextPopulation(
  current: PromptVariant[],
  summaries: VariantSummary[],
  trials: TrialResult[],
  config: GepaConfig,
  nextGeneration: number,
): Promise<PromptVariant[]> {
  // Pareto-pick survivors. Then ask the mutator for replacements until we hit
  // the population cap. Survivors keep their identity (no re-eval needed if we
  // ever cache trials by hash; for now we re-evaluate every generation).
  const candidates = summaries.map((s) => ({ item: s.variantId, vector: vectorFromSummary(s) }))
  const front = paretoFront(candidates)
  const survivorIds = new Set(front.map((c) => c.item))
  const survivors = current.filter((v) => survivorIds.has(v.id))

  // The "best" survivor (highest scalar) seeds mutation if multiple survive.
  const ranked = [...summaries].sort((a, b) => scalarScore(vectorFromSummary(b)) - scalarScore(vectorFromSummary(a)))
  const parent = current.find((v) => v.id === ranked[0]?.variantId) ?? current[0]!
  const parentSummary = summaries.find((s) => s.variantId === parent.id)!

  const topTrials = topK(trials, parent.id, 3)
  const bottomTrials = bottomK(trials, parent.id, 3)
  const childCount = Math.max(0, config.populationSize - survivors.length)

  let children: PromptVariant[] = []
  if (childCount > 0) {
    children = await config.mutateAdapter.mutate({
      parent,
      topTrials,
      bottomTrials,
      parentSummary,
      childCount,
      generation: nextGeneration,
    })
    children = children.slice(0, childCount).map((c) => ({ ...c, generation: nextGeneration }))
  }

  return [...survivors, ...children]
}

function topK(trials: TrialResult[], variantId: string, k: number): TrialResult[] {
  return trials
    .filter((t) => t.variantId === variantId && t.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

function bottomK(trials: TrialResult[], variantId: string, k: number): TrialResult[] {
  return trials
    .filter((t) => t.variantId === variantId && t.ok)
    .sort((a, b) => a.score - b.score)
    .slice(0, k)
}

/** Convenience: stamp a fresh variant id. */
export function newVariantId(target: string): string {
  return `${target}-${randomUUID().slice(0, 8)}`
}
