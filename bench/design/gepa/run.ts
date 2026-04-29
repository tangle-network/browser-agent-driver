/**
 * Design-audit GEPA runner — the actual CLI entry.
 *
 *   pnpm tsx bench/design/gepa/run.ts \
 *     --target pass-focus \
 *     --population 4 \
 *     --generations 2 \
 *     --reps 1 \
 *     --concurrency 4 \
 *     --mutator deterministic \
 *     --fixtures no-primary-action,generic-dashboard,empty-state-noise
 *
 * Reads fixtures from bench/design/gepa/fixtures/fixtures.json. Writes
 * generation reports to .evolve/gepa/<runId>/. Appends one summary row to
 * .evolve/experiments.jsonl per run.
 */

import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { Brain } from '../../../src/brain/index.js'
import { loadLocalEnvFiles } from '../../../src/env-loader.js'
import { resolveProviderApiKey, resolveProviderModelName, type SupportedProvider } from '../../../src/provider-defaults.js'
import { setCliVersion, setInvocation, getTelemetry } from '../../../src/telemetry/index.js'
import { loadFixtures, selectFixtures } from './fixtures/loader.js'
import { runGepaLoop, type GepaConfig } from './loop.js'
import { AuditScoreAdapter } from './score-adapter.js'
import { DeterministicMutator, ReflectiveMutator } from './mutators.js'
import { KNOWN_TARGETS, seedFor } from './targets.js'
import { appendExperiment } from './scorecard.js'
import { scalarScore } from './pareto.js'
import { vectorFromSummary } from './scorecard.js'
import type { GepaTargetId, PromptVariant } from './types.js'

interface CliArgs {
  target: GepaTargetId
  population: number
  generations: number
  reps: number
  concurrency: number
  mutator: 'deterministic' | 'reflective'
  fixtures?: string[]
  provider: SupportedProvider
  model?: string
  baseUrl?: string
  reportDir?: string
  evolveDir: string
  earlyStop: boolean
}

async function main(): Promise<void> {
  loadLocalEnvFiles(process.cwd())
  setCliVersion('gepa')
  setInvocation('design-audit:gepa', process.argv.slice(2))

  const args = parseCliArgs()
  if (!KNOWN_TARGETS.includes(args.target)) {
    throw new Error(`unknown --target ${args.target}; one of: ${KNOWN_TARGETS.join(', ')}`)
  }

  const fixturesData = loadFixtures()
  const fixtures = selectFixtures(fixturesData.fixtures, args.fixtures)
  if (fixtures.length === 0) {
    throw new Error('no fixtures selected — pass --fixtures <id,id> or remove the flag')
  }

  const seed = seedFor(args.target)
  const seedVariants: PromptVariant[] = [seed.variant]

  const runId = randomUUID()
  const reportDir = args.reportDir ?? path.join(process.cwd(), '.evolve', 'gepa', runId)
  fs.mkdirSync(reportDir, { recursive: true })

  // ── Wire the score adapter (reused across the whole run) ──
  const adapter = new AuditScoreAdapter({
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    headless: true,
    screenshotDir: path.join(reportDir, 'screenshots'),
  })
  await adapter.start()

  // ── Pick mutator ──
  let mutateAdapter: GepaConfig['mutateAdapter']
  if (args.mutator === 'reflective') {
    const provider = args.provider
    const modelName = resolveProviderModelName(provider, args.model)
    const apiKey = resolveProviderApiKey(provider)
    const brain = new Brain({ provider, model: modelName, apiKey, baseUrl: args.baseUrl ?? process.env.LLM_BASE_URL, vision: false, llmTimeoutMs: 120_000 })
    mutateAdapter = new ReflectiveMutator(brain, args.target)
  } else {
    mutateAdapter = new DeterministicMutator(args.target)
  }

  console.log(`[gepa] runId=${runId} target=${args.target} fixtures=${fixtures.length} pop=${args.population} gens=${args.generations} reps=${args.reps} mutator=${args.mutator}`)

  const t0 = Date.now()
  let result
  try {
    result = await runGepaLoop({
      runId,
      target: args.target,
      seedVariants,
      fixtures,
      reps: args.reps,
      generations: args.generations,
      populationSize: args.population,
      scoreConcurrency: args.concurrency,
      scoreAdapter: adapter,
      mutateAdapter,
      reportDir,
      earlyStopOnNoImprovement: args.earlyStop,
      onProgress: (event) => {
        if (event.type === 'trial-complete') {
          console.log(`  · gen=${event.generation} variant=${event.variantId} fixture=${event.fixtureId} rep=${event.rep} ok=${event.ok} recall=${event.recall.toFixed(2)}`)
        } else if (event.type === 'generation-complete') {
          console.log(`[gepa] gen ${event.report.generation} winner=${event.report.winnerId} delta=${event.report.delta.toFixed(3)} pareto=${event.report.paretoFrontIds.length}`)
        } else if (event.type === 'converged') {
          console.log(`[gepa] converged at gen ${event.generation}: ${event.reason}`)
        } else {
          console.log(`[gepa] gen ${event.generation} pop=${event.populationSize}`)
        }
      },
    })
  } finally {
    await adapter.stop()
  }

  const durationMs = Date.now() - t0

  // ── Append a summary row to .evolve/experiments.jsonl ──
  const baselineScalar = scalarScore(result.baselineVector)
  const winnerScalar = scalarScore(result.bestVector)
  appendExperiment(
    {
      id: `gepa-${runId.slice(0, 8)}`,
      project: 'browser-agent-driver',
      goal: `GEPA prompt evolution — target=${args.target}`,
      round: null,
      generation: result.generations.length,
      hypothesis: `Mutating ${args.target} via ${args.mutator} improves the multi-objective Pareto frontier (recall, precision, orthogonality, stability, cost) over baseline.`,
      category: 'gepa',
      lever: args.target,
      targets: ['src/design/audit/evaluate.ts'],
      baseline: result.baselineVector,
      result: result.bestVector,
      delta: winnerScalar - baselineScalar,
      verdict: winnerScalar > baselineScalar + 0.01 ? 'ADVANCE' : winnerScalar > baselineScalar - 0.01 ? 'KEEP' : 'INCONCLUSIVE',
      durationMs,
      timestamp: new Date().toISOString(),
      reasoning: `Ran ${args.generations} generations × ${args.population} variants × ${fixtures.length} fixtures × ${args.reps} reps using the ${args.mutator} mutator.`,
      learnings: [],
      deploymentVerified: false,
      failureMode: null,
      gepa: {
        target: args.target,
        variantsEvaluated: result.generations.reduce((n, g) => n + g.variants.length, 0),
        paretoFrontIds: result.generations[result.generations.length - 1]?.paretoFrontIds ?? [],
        winnerId: result.bestVariant.id,
        runId,
      },
    },
    args.evolveDir,
  )

  // Per-run telemetry envelope so fleet rollup can index this GEPA run.
  getTelemetry().emit({
    kind: 'gepa-generation',
    runId,
    ok: true,
    durationMs,
    data: {
      target: args.target,
      mutator: args.mutator,
      fixtures: fixtures.map((f) => f.id),
      generations: result.generations.length,
      winnerId: result.bestVariant.id,
      paretoFrontIds: result.generations[result.generations.length - 1]?.paretoFrontIds ?? [],
    },
    metrics: {
      baselineScalar,
      winnerScalar,
      delta: winnerScalar - baselineScalar,
      generations: result.generations.length,
      variantsEvaluated: result.generations.reduce((n, g) => n + g.variants.length, 0),
      fixtures: fixtures.length,
    },
  })

  console.log(`[gepa] complete · winner=${result.bestVariant.id} scalar Δ ${(winnerScalar - baselineScalar).toFixed(3)} · report=${reportDir}`)
  await getTelemetry().close()
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      population: { type: 'string' },
      generations: { type: 'string' },
      reps: { type: 'string' },
      concurrency: { type: 'string' },
      mutator: { type: 'string' },
      fixtures: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'report-dir': { type: 'string' },
      'evolve-dir': { type: 'string' },
      'no-early-stop': { type: 'boolean' },
    },
    allowPositionals: false,
  })

  const target = (values.target ?? 'pass-focus') as GepaTargetId
  const population = parseInt(values.population ?? '4', 10)
  const generations = parseInt(values.generations ?? '2', 10)
  const reps = parseInt(values.reps ?? '1', 10)
  const concurrency = parseInt(values.concurrency ?? '4', 10)
  const mutator = (values.mutator ?? 'deterministic') as 'deterministic' | 'reflective'
  const fixtures = values.fixtures ? values.fixtures.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const provider = (values.provider ?? 'claude-code') as SupportedProvider
  const reportDir = values['report-dir']
  const evolveDir = values['evolve-dir'] ?? path.join(process.cwd(), '.evolve')
  const earlyStop = !values['no-early-stop']

  return {
    target,
    population: Number.isFinite(population) ? population : 4,
    generations: Number.isFinite(generations) ? generations : 2,
    reps: Number.isFinite(reps) ? reps : 1,
    concurrency: Number.isFinite(concurrency) ? concurrency : 4,
    mutator,
    fixtures,
    provider,
    ...(values.model ? { model: values.model } : {}),
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
    ...(reportDir ? { reportDir } : {}),
    evolveDir,
    earlyStop,
  }
}

main().catch((err) => {
  console.error('[gepa] error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
