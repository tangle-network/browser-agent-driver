/**
 * Run Registry — orchestration-facing run manifest storage.
 *
 * Provides a structured API for external orchestrators (Foreman) to
 * enumerate, inspect, resume, and fork browser agent runs.
 *
 * Separate from AppKnowledge: knowledge.json is the LLM-facing memory
 * substrate, runs/*.json is the orchestration-facing substrate.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export type RunStatus = 'running' | 'completed' | 'failed'

export interface RunManifest {
  runId: string
  sessionId?: string
  parentRunId?: string
  status: RunStatus
  goal: string
  domain: string
  startUrl?: string
  finalUrl?: string
  currentUrl?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  success?: boolean
  summary?: string
  artifactPaths: string[]
  turnCount: number
  result?: string
  reason?: string
}

export interface RunFilters {
  domain?: string
  sessionId?: string
  status?: RunStatus
  limit?: number
}

export class RunRegistry {
  private dir: string

  constructor(memoryDir: string) {
    this.dir = join(memoryDir, 'agent-runs')
  }

  /** Create a new run manifest at start. Returns the runId. */
  startRun(opts: {
    runId: string
    sessionId?: string
    parentRunId?: string
    goal: string
    domain: string
    startUrl?: string
  }): string {
    this.ensureDir()
    const manifest: RunManifest = {
      runId: opts.runId,
      sessionId: opts.sessionId,
      parentRunId: opts.parentRunId,
      status: 'running',
      goal: opts.goal,
      domain: opts.domain,
      startUrl: opts.startUrl,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactPaths: [],
      turnCount: 0,
    }
    this.write(manifest)
    return opts.runId
  }

  /** Update a run manifest (e.g., on completion or failure). */
  updateRun(runId: string, updates: Partial<Omit<RunManifest, 'runId' | 'startedAt'>>): RunManifest | undefined {
    const manifest = this.getRun(runId)
    if (!manifest) return undefined
    Object.assign(manifest, updates, { updatedAt: new Date().toISOString() })
    this.write(manifest)
    return manifest
  }

  /** Complete a run with final results. */
  completeRun(runId: string, result: {
    success: boolean
    finalUrl?: string
    summary?: string
    result?: string
    reason?: string
    turnCount: number
    artifactPaths?: string[]
  }): RunManifest | undefined {
    return this.updateRun(runId, {
      status: result.success ? 'completed' : 'failed',
      success: result.success,
      finalUrl: result.finalUrl,
      summary: result.summary,
      result: result.result,
      reason: result.reason,
      turnCount: result.turnCount,
      artifactPaths: result.artifactPaths || [],
      completedAt: new Date().toISOString(),
    })
  }

  /** Get a single run by ID. */
  getRun(runId: string): RunManifest | undefined {
    const path = this.manifestPath(runId)
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as RunManifest
    } catch {
      return undefined
    }
  }

  /** List runs matching optional filters, newest first. */
  listRuns(filters?: RunFilters): RunManifest[] {
    if (!existsSync(this.dir)) return []
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    let manifests: RunManifest[] = []
    for (const file of files) {
      try {
        const m = JSON.parse(readFileSync(join(this.dir, file), 'utf-8')) as RunManifest
        manifests.push(m)
      } catch {
        // skip corrupted
      }
    }

    if (filters?.domain) {
      manifests = manifests.filter(m => m.domain === filters.domain)
    }
    if (filters?.sessionId) {
      manifests = manifests.filter(m => m.sessionId === filters.sessionId)
    }
    if (filters?.status) {
      manifests = manifests.filter(m => m.status === filters.status)
    }

    manifests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    if (filters?.limit && filters.limit > 0) {
      manifests = manifests.slice(0, filters.limit)
    }

    return manifests
  }

  /** Build a resume scenario from a previous run. */
  buildResumeScenario(runId: string, newGoal?: string): {
    goal: string
    startUrl: string
    sessionId?: string
    parentRunId: string
  } | undefined {
    const manifest = this.getRun(runId)
    if (!manifest) return undefined
    return {
      goal: newGoal || manifest.goal,
      startUrl: manifest.finalUrl || manifest.startUrl || '',
      sessionId: manifest.sessionId,
      parentRunId: manifest.runId,
    }
  }

  /** Build a fork scenario — new sessionId, inherits startUrl from parent. */
  buildForkScenario(runId: string, goal: string): {
    goal: string
    startUrl: string
    sessionId: string
    parentRunId: string
  } | undefined {
    const manifest = this.getRun(runId)
    if (!manifest) return undefined
    return {
      goal,
      startUrl: manifest.finalUrl || manifest.startUrl || '',
      sessionId: `fork_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      parentRunId: manifest.runId,
    }
  }

  /** Generate a unique run ID. */
  static generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private manifestPath(runId: string): string {
    // Sanitize runId for filesystem safety
    const safe = runId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  private write(manifest: RunManifest): void {
    this.ensureDir()
    writeFileSync(this.manifestPath(manifest.runId), JSON.stringify(manifest, null, 2))
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
  }
}
