/**
 * Layer 3 — First-principles fallback.
 *
 * When the ensemble classifier is uncertain the auditor does not fabricate a
 * classification. This module decides when to trigger first-principles mode
 * and queues NovelPatternObservations for fleet mining.
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type { EnsembleClassification, NovelPatternObservation, PageType } from './score-types.js'

export interface FirstPrinciplesOptions {
  /** Override the minimum ensemble confidence threshold (default 0.6). */
  confidenceThreshold?: number
}

/**
 * Returns true when first-principles mode should fire.
 *
 * Trigger conditions (ANY of):
 *   - ensembleConfidence < threshold (default 0.6)
 *   - signalsAgreed === false
 *   - classification.type === 'unknown'
 *   - LLM explicitly emitted first_principles_mode: true
 */
export function shouldTriggerFirstPrinciples(
  classification: EnsembleClassification,
  opts?: FirstPrinciplesOptions,
): boolean {
  const threshold = opts?.confidenceThreshold ?? 0.6
  if (classification.ensembleConfidence < threshold) return true
  if (!classification.signalsAgreed) return true
  if ((classification.type as string) === 'unknown') return true
  if (classification.firstPrinciplesMode) return true
  return false
}

/**
 * Build a NovelPatternObservation from the classification and runtime context.
 * The `observationId` is stable: same pageRef + capturedAt minute → same id.
 */
export function buildNovelPatternObservation(args: {
  classification: EnsembleClassification
  pageRef: string
  observedSignals?: string
  snapshotKey?: string
}): NovelPatternObservation {
  const capturedAt = new Date().toISOString()
  const observationId = crypto
    .createHash('sha256')
    .update(`${args.pageRef}::${capturedAt.slice(0, 16)}`)
    .digest('hex')
    .slice(0, 16)

  return {
    observationId,
    capturedAt,
    observed: args.observedSignals ?? 'No specific signal description provided.',
    closestType: args.classification.type as PageType,
    closestConfidence: args.classification.ensembleConfidence,
    pageRef: args.pageRef,
    ...(args.snapshotKey ? { snapshotKey: args.snapshotKey } : {}),
  }
}

/**
 * Append a NovelPatternObservation as a JSONL line to the date-stamped sink.
 * Default dir: `~/.bad/novel-patterns/`. Each line is valid JSON on its own.
 */
export async function appendNovelPatternObservation(
  observation: NovelPatternObservation,
  dir?: string,
): Promise<void> {
  const sinkDir = dir ?? path.join(os.homedir(), '.bad', 'novel-patterns')
  await fsp.mkdir(sinkDir, { recursive: true })
  const date = observation.capturedAt.slice(0, 10)
  const filePath = path.join(sinkDir, `${date}.jsonl`)
  const line = JSON.stringify(observation) + '\n'
  await fsp.appendFile(filePath, line, 'utf-8')
}

/**
 * Synchronous variant — for use in pipeline paths that aren't async.
 */
export function appendNovelPatternObservationSync(
  observation: NovelPatternObservation,
  dir?: string,
): void {
  const sinkDir = dir ?? path.join(os.homedir(), '.bad', 'novel-patterns')
  fs.mkdirSync(sinkDir, { recursive: true })
  const date = observation.capturedAt.slice(0, 10)
  const filePath = path.join(sinkDir, `${date}.jsonl`)
  fs.appendFileSync(filePath, JSON.stringify(observation) + '\n', 'utf-8')
}
