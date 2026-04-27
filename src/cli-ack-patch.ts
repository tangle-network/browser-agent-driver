/**
 * Layer 4 — `bad design-audit ack-patch` subcommand handler.
 *
 * Invoked by coding agents after applying a patch:
 *   bad design-audit ack-patch <patchId> --pre-run-id <runId> [--applied-by <who>]
 *
 * When a re-audit is run with `--post-patch <patchId>`, the pipeline looks up
 * the pending application and writes the observed outcome. This file handles
 * the ack-patch side; the --post-patch flow lives in pipeline.ts.
 */

import * as crypto from 'node:crypto'
import type { PatchApplication } from './design/audit/attribution/types.js'
import type { Dimension } from './design/audit/score-types.js'
import {
  appendPatchApplication,
  patchHash,
  findPendingApplication,
  updateApplicationOutcome,
} from './design/audit/attribution/store.js'

export interface AckPatchOptions {
  patchId: string
  preRunId: string
  appliedBy?: string
  predictedDim?: string
  predictedDelta?: number
  patchBefore?: string
  patchAfter?: string
  patchScope?: string
  dir?: string
}

/**
 * Record that a patch was applied. Returns the applicationId for correlation.
 * The predicted delta is optional — when not provided, defaults to 'untested'.
 */
export async function ackPatch(opts: AckPatchOptions): Promise<string> {
  const applicationId = crypto.randomUUID()
  const hash = patchHash(
    { before: opts.patchBefore ?? '', after: opts.patchAfter ?? '' },
    opts.patchScope ?? 'component',
  )

  const app: PatchApplication = {
    applicationId,
    patchId: opts.patchId,
    patchHash: hash,
    appliedAt: new Date().toISOString(),
    appliedBy: opts.appliedBy ?? 'agent:unknown',
    preAuditRunId: opts.preRunId,
    predicted: {
      dim: (opts.predictedDim ?? 'product_intent') as Dimension,
      delta: opts.predictedDelta ?? 0,
    },
  }

  await appendPatchApplication(app, opts.dir)
  return applicationId
}

export interface PostPatchOptions {
  patchId: string
  postRunId: string
  observedDim: string
  observedDelta: number
  dir?: string
}

/**
 * Record the observed outcome after a re-audit. Looks up the pending
 * application for `patchId` and appends an outcome event.
 */
export async function recordPatchOutcome(opts: PostPatchOptions): Promise<void> {
  const pending = await findPendingApplication(opts.patchId, opts.dir)
  if (!pending) {
    throw new Error(
      `No pending PatchApplication found for patchId ${opts.patchId}. ` +
        'Run `bad design-audit ack-patch` after applying the patch, before re-auditing.',
    )
  }

  await updateApplicationOutcome(
    pending.applicationId,
    opts.postRunId,
    { dim: opts.observedDim as Dimension, delta: opts.observedDelta },
    opts.dir,
  )
}
