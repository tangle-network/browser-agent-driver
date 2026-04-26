/**
 * Layer 4 — Append-only JSONL store for PatchApplication records.
 *
 * Layout: `<dir>/applications/<YYYY-MM-DD>.jsonl`
 * Each line is a standalone JSON object — `patchHash` is always set so cross-
 * tenant aggregation can group by patch signature, not per-tenant path.
 *
 * Append-only invariant: never mutate existing lines. Outcome updates are
 * recorded as NEW lines so the JSONL is an event stream, not a state snapshot.
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type { PatchApplication } from './types.js'

const DEFAULT_DIR = path.join(os.homedir(), '.bad', 'attribution')

function applicationsDir(dir: string): string {
  return path.join(dir, 'applications')
}

function todayPath(dir: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(applicationsDir(dir), `${date}.jsonl`)
}

/**
 * Stable hash for a patch diff + scope. Same patch content across tenants →
 * same hash, enabling cross-tenant reliability aggregation.
 */
export function patchHash(diff: { before: string; after: string }, scope: string): string {
  return crypto
    .createHash('sha256')
    .update(`${diff.before}\n---\n${diff.after}\n---\n${scope}`)
    .digest('hex')
    .slice(0, 16)
}

/** Append a new PatchApplication record. */
export async function appendPatchApplication(
  app: PatchApplication,
  dir: string = DEFAULT_DIR,
): Promise<void> {
  await fsp.mkdir(applicationsDir(dir), { recursive: true })
  await fsp.appendFile(todayPath(dir), JSON.stringify(app) + '\n', 'utf-8')
}

/** Sync variant for non-async call sites. */
export function appendPatchApplicationSync(
  app: PatchApplication,
  dir: string = DEFAULT_DIR,
): void {
  fs.mkdirSync(applicationsDir(dir), { recursive: true })
  fs.appendFileSync(todayPath(dir), JSON.stringify(app) + '\n', 'utf-8')
}

/** Read all PatchApplication records from the last `days` days. */
export async function readRecentApplications(
  days: number = 7,
  dir: string = DEFAULT_DIR,
): Promise<PatchApplication[]> {
  const appsDir = applicationsDir(dir)
  if (!fs.existsSync(appsDir)) return []

  const results: PatchApplication[] = []
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
    const filePath = path.join(appsDir, `${date}.jsonl`)
    if (!fs.existsSync(filePath)) continue
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as PatchApplication)
      } catch {
        // corrupt line — skip
      }
    }
  }
  return results
}

/**
 * Find the most recent pending application for a patchId — one that has no
 * `postAuditRunId` yet. Used when a re-audit lands to attach the outcome.
 */
export async function findPendingApplication(
  patchId: string,
  dir: string = DEFAULT_DIR,
): Promise<PatchApplication | null> {
  const apps = await readRecentApplications(7, dir)
  // Most recent first; pick the newest pending one.
  const pending = apps
    .filter(a => a.patchId === patchId && !a.postAuditRunId)
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
  return pending[0] ?? null
}

/**
 * Append an outcome event for an existing application. Does NOT mutate the
 * original line — appends a new event so the JSONL remains an event stream.
 */
export async function updateApplicationOutcome(
  applicationId: string,
  postAuditRunId: string,
  observed: PatchApplication['observed'],
  dir: string = DEFAULT_DIR,
): Promise<void> {
  const apps = await readRecentApplications(7, dir)
  const original = apps.find(a => a.applicationId === applicationId)
  if (!original) {
    throw new Error(`PatchApplication ${applicationId} not found in the last 7 days`)
  }

  const agreementScore = computeAgreementScore(original.predicted, observed)
  const outcome: PatchApplication = {
    ...original,
    postAuditRunId,
    observed,
    agreementScore,
  }

  await fsp.mkdir(applicationsDir(dir), { recursive: true })
  await fsp.appendFile(todayPath(dir), JSON.stringify(outcome) + '\n', 'utf-8')
}

function computeAgreementScore(
  predicted: PatchApplication['predicted'],
  observed: PatchApplication['observed'],
): number {
  if (!predicted || !observed) return 0
  const p = predicted.delta
  const o = observed.delta
  const denom = Math.max(Math.abs(p), Math.abs(o), 1)
  return 1 - Math.abs(p - o) / denom
}
