/**
 * GEPA scorecard — appends results to `.evolve/experiments.jsonl` and writes a
 * summary file under `.evolve/gepa/<run-id>/`. Schema is a strict superset of
 * the existing experiments.jsonl shape so the rest of the evolve loop keeps
 * working without changes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { GepaTargetId, ObjectiveVector, PromptVariant, VariantSummary } from './types.js'
import { paretoFront, scalarScore, type ParetoCandidate } from './pareto.js'

export interface GepaExperiment {
  id: string
  project: string
  goal: string
  round: null
  generation: number
  hypothesis: string
  category: 'gepa'
  lever: GepaTargetId
  targets: string[]
  baseline: ObjectiveVector
  result: ObjectiveVector
  delta: number
  verdict: 'ADVANCE' | 'KEEP' | 'REVERT' | 'INCONCLUSIVE'
  durationMs: number
  timestamp: string
  reasoning: string
  learnings: string[]
  deploymentVerified: boolean
  failureMode: string | null
  /** GEPA-specific metadata. */
  gepa: {
    target: GepaTargetId
    variantsEvaluated: number
    paretoFrontIds: string[]
    winnerId: string
    runId: string
  }
}

export interface GenerationReport {
  runId: string
  target: GepaTargetId
  generation: number
  timestamp: string
  variants: Array<{
    variant: PromptVariant
    summary: VariantSummary
    scalar: number
    onPareto: boolean
  }>
  paretoFrontIds: string[]
  winnerId: string
  baseline: ObjectiveVector
  bestVector: ObjectiveVector
  delta: number
}

export function buildGenerationReport(args: {
  runId: string
  target: GepaTargetId
  generation: number
  variants: PromptVariant[]
  summaries: VariantSummary[]
  baseline: ObjectiveVector
  baselineId: string
}): GenerationReport {
  const { runId, target, generation, variants, summaries, baseline, baselineId } = args
  const candidates: Array<ParetoCandidate<string>> = summaries.map((s) => ({
    item: s.variantId,
    vector: vectorFromSummary(s),
  }))
  const front = paretoFront(candidates)
  const frontIds = new Set(front.map((c) => c.item))

  const scored = summaries.map((s) => ({
    id: s.variantId,
    vector: vectorFromSummary(s),
    scalar: scalarScore(vectorFromSummary(s)),
  }))
  scored.sort((a, b) => b.scalar - a.scalar)
  const winnerId = scored[0]?.id ?? baselineId
  const bestVector = scored[0]?.vector ?? baseline

  return {
    runId,
    target,
    generation,
    timestamp: new Date().toISOString(),
    variants: variants.map((v) => {
      const summary = summaries.find((s) => s.variantId === v.id)!
      const scalar = scored.find((s) => s.id === v.id)?.scalar ?? 0
      return {
        variant: v,
        summary,
        scalar,
        onPareto: frontIds.has(v.id),
      }
    }),
    paretoFrontIds: [...frontIds],
    winnerId,
    baseline,
    bestVector,
    delta: scalarScore(bestVector) - scalarScore(baseline),
  }
}

export function writeGenerationReport(
  report: GenerationReport,
  outputDir: string,
): { reportPath: string; markdownPath: string } {
  fs.mkdirSync(outputDir, { recursive: true })
  const reportPath = path.join(outputDir, `gen-${report.generation}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const markdownPath = path.join(outputDir, `gen-${report.generation}.md`)
  fs.writeFileSync(markdownPath, renderGenerationMarkdown(report))
  return { reportPath, markdownPath }
}

export function appendExperiment(
  experiment: GepaExperiment,
  evolveDir: string,
): void {
  fs.mkdirSync(evolveDir, { recursive: true })
  const filePath = path.join(evolveDir, 'experiments.jsonl')
  fs.appendFileSync(filePath, JSON.stringify(experiment) + '\n')
}

export function vectorFromSummary(summary: VariantSummary): ObjectiveVector {
  return {
    recall: summary.recall,
    precision: summary.precision,
    passOrthogonality: summary.passOrthogonality,
    scoreStability: Math.max(0, 1 - summary.scoreStdDev / 3),
    cost: summary.meanCost,
  }
}

function renderGenerationMarkdown(report: GenerationReport): string {
  const lines: string[] = []
  lines.push(`# GEPA · ${report.target} · gen ${report.generation}`)
  lines.push('')
  lines.push(`Run: \`${report.runId}\` · ${report.timestamp}`)
  lines.push('')
  lines.push(`Winner: \`${report.winnerId}\` · scalar Δ ${report.delta.toFixed(3)} vs baseline`)
  lines.push('')
  lines.push('| variant | recall | precision | orthog | stability | cost | scalar | pareto |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|:--:|')
  const sorted = [...report.variants].sort((a, b) => b.scalar - a.scalar)
  for (const v of sorted) {
    const s = v.summary
    lines.push(
      `| ${v.variant.label} | ${s.recall.toFixed(2)} | ${s.precision.toFixed(2)} | ${s.passOrthogonality.toFixed(2)} | ${(1 - Math.min(1, s.scoreStdDev / 3)).toFixed(2)} | ${Math.round(s.meanCost)} | ${v.scalar.toFixed(3)} | ${v.onPareto ? '✓' : ''} |`,
    )
  }
  lines.push('')
  lines.push('## Variants')
  lines.push('')
  for (const v of sorted) {
    lines.push(`### \`${v.variant.id}\` — ${v.variant.label}`)
    if (v.variant.rationale) lines.push(`_${v.variant.rationale}_`)
    lines.push('')
  }
  return lines.join('\n')
}
