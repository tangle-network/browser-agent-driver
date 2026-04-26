/**
 * Agentic orchestrator — wraps `runJob` with a control loop that handles
 * strategic decisions (re-sample broken wayback snapshots, retry vs skip,
 * widen the window when too many fail, conclude) via LLM tool calls.
 *
 * Design: protocols are deterministic (retry/backoff lives in `retry.ts`,
 * anti-bot detection lives in `anti-bot.ts`). The orchestrator only steps
 * in for *judgment* calls where a hand-tuned heuristic would break the
 * moment the world changes. Cost ceiling: hard-capped at spec.maxCostUSD,
 * and each control-loop iteration is a single LLM call (~1.5s, ~$0.005).
 *
 * Tool surface (LLM-callable):
 *   getJobState()        — what's done, what failed, current cost
 *   resampleWayback(...) — replace targets for a URL with a new sample
 *   retryTarget(...)     — re-attempt a single failed/skipped target
 *   markSkipped(...)     — terminal skip with reason
 *   concludeJob()        — exit the loop
 *
 * The orchestrator runs the initial fan-out via `runJob` first (so the
 * deterministic happy path doesn't pay LLM tax), then enters the loop only
 * if the result needs intervention.
 */

import { generateText, tool, jsonSchema, stepCountIs } from 'ai'
import { Brain } from '../brain/index.js'
import { resolveProviderApiKey, resolveProviderModelName, type SupportedProvider } from '../provider-defaults.js'
import { runJob, type AuditFn } from './queue.js'
import { saveJob, appendIndexEntry } from './store.js'
import { discoverWaybackSnapshots } from '../discover/wayback.js'
import type { Job, JobTarget, JobResultEntry } from './types.js'

export interface OrchestrateJobOptions {
  auditFn: AuditFn
  /** Persistence dir override (tests). */
  dir?: string
  /** Cap on agent control-loop iterations. Default 8. */
  maxIterations?: number
  /** Override the LLM provider (tests). Defaults to the default Brain. */
  brain?: Brain
  /** When true, log every tool call. */
  verbose?: boolean
}

const SYSTEM_PROMPT = `You are an audit-job orchestrator.

Your job: bring this audit job to a high-quality completion. After the initial fan-out has run, decide whether and how to fix gaps:
  - If multiple wayback snapshots for the same URL came back blocked or scored 0, the snapshots are likely broken archive captures. Re-sample more snapshots in the same window using the resampleWayback tool.
  - If a single target failed with a transient error, retry it.
  - If a target is structurally unfixable (anti-bot, persistent 4xx, total content failure), mark it skipped with a clear reason.
  - When the job is in good shape OR you've hit diminishing returns OR cost is approaching the cap, call concludeJob.

Rules:
  - You MUST stay under spec.maxCostUSD when set.
  - Do not retry the same target more than twice.
  - Do not resample the same URL more than once.
  - When in doubt, conclude. A clean partial job is better than an over-fitted one.
  - Reply only with tool calls until you call concludeJob.
`

interface ResampleAction {
  url: string
  count: number
  since?: string
  until?: string
  attempted: boolean
}

interface OrchestratorState {
  job: Job
  resamples: Map<string, ResampleAction>
  retries: Map<string, number>
  concluded: boolean
  reason: string
}

export async function orchestrateJob(job: Job, opts: OrchestrateJobOptions): Promise<Job> {
  const verbose = opts.verbose ?? false
  // Phase 1: deterministic fan-out (no LLM in the loop).
  await runJob(job, { auditFn: opts.auditFn, dir: opts.dir })

  const state: OrchestratorState = {
    job,
    resamples: new Map(),
    retries: new Map(),
    concluded: false,
    reason: '',
  }

  // Phase 2: only invoke the agent if the run needs intervention.
  if (!needsIntervention(job)) {
    if (verbose) console.log('  [orchestrator] no intervention needed')
    return job
  }

  if (verbose) {
    const failed = job.results.filter(r => r.status === 'failed').length
    const skipped = job.results.filter(r => r.status === 'skipped').length
    console.log(`  [orchestrator] entering loop · failed=${failed} · skipped=${skipped} · cost=$${job.totalCostUSD.toFixed(2)}`)
  }

  // Default to the same provider as the audit pipeline (claude-code via
  // subscription, no API key required). If the operator already supplied a
  // brain, respect that.
  const brain = opts.brain ?? defaultBrain()
  const tools = buildTools(state, opts, verbose)
  const model = await brain.getLanguageModel({ provider: 'claude-code' as never })

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: 'The fan-out has completed. Call getJobState first to see what happened, then take corrective actions, then call concludeJob.',
    tools,
    stopWhen: stepCountIs(opts.maxIterations ?? 8),
  })
  if (verbose) {
    console.log(`  [orchestrator] finishReason=${result.finishReason}  steps=${result.steps.length}  toolCalls=${result.steps.reduce((acc, s) => acc + s.toolCalls.length, 0)}`)
    if (result.text) console.log(`  [orchestrator] final-text: ${result.text.slice(0, 200)}`)
  }

  if (!state.concluded) {
    state.reason = 'orchestrator: max iterations reached without explicit conclude'
  }
  // Persist final state.
  saveJob(state.job, opts.dir)
  appendIndexEntry(state.job, opts.dir)
  return state.job
}

/** Cheap deterministic check: did the fan-out leave anything worth fixing? */
function needsIntervention(job: Job): boolean {
  const failed = job.results.filter(r => r.status === 'failed').length
  const ok = job.results.filter(r => r.status === 'ok')
  const skipped = job.results.filter(r => r.status === 'skipped').length
  // Coverage: anything missing or failed is an intervention candidate.
  if (failed > 0) return true
  if (ok.length + skipped < job.targets.length) return true
  // Quality: zero-scored ok results from wayback snapshots almost always
  // indicate a broken archive capture (anti-bot got past detection, or the
  // archived page is truncated). Treat as intervention-worthy.
  const zeroScored = ok.filter(r => r.snapshotUrl && (r.rollupScore ?? -1) === 0).length
  if (zeroScored > 0) return true
  return false
}

function buildTools(state: OrchestratorState, opts: OrchestrateJobOptions, verbose: boolean) {
  return {
    getJobState: tool({
      description: 'Return the current job state — targets, results, totalCostUSD, maxCostUSD, recent failures, and which URLs already have re-sampled targets.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async () => {
        const j = state.job
        const groupedByUrl = new Map<string, JobResultEntry[]>()
        for (const r of j.results) {
          const k = r.url
          if (!groupedByUrl.has(k)) groupedByUrl.set(k, [])
          groupedByUrl.get(k)!.push(r)
        }
        const summary = {
          jobId: j.jobId,
          status: j.status,
          totalCostUSD: j.totalCostUSD,
          maxCostUSD: j.spec.maxCostUSD ?? null,
          targets: j.targets.length,
          ok: j.results.filter(r => r.status === 'ok').length,
          failed: j.results.filter(r => r.status === 'failed').length,
          skipped: j.results.filter(r => r.status === 'skipped').length,
          retriesUsed: Array.from(state.retries.entries()).map(([k, n]) => ({ key: k, retries: n })),
          resamplesUsed: Array.from(state.resamples.values()).filter(r => r.attempted).map(r => r.url),
          byUrl: Array.from(groupedByUrl.entries()).map(([url, rows]) => ({
            url,
            snapshots: rows.length,
            ok: rows.filter(r => r.status === 'ok').length,
            failed: rows.filter(r => r.status === 'failed').length,
            skipped: rows.filter(r => r.status === 'skipped').length,
            zeroScored: rows.filter(r => r.status === 'ok' && (r.rollupScore ?? 0) === 0).length,
          })),
          failureSamples: j.results.filter(r => r.status === 'failed').slice(0, 5).map(r => ({
            url: r.url, snapshotUrl: r.snapshotUrl, error: r.error,
          })),
          skippedSamples: j.results.filter(r => r.status === 'skipped').slice(0, 5).map(r => ({
            url: r.url, snapshotUrl: r.snapshotUrl, reason: r.error,
          })),
        }
        if (verbose) console.log('  [orchestrator] getJobState')
        return summary
      },
    }),

    resampleWayback: tool({
      description: 'Discover N additional wayback snapshots for a URL and audit them. Use when several existing snapshots for that URL came back blocked or zero-scored — broken archive captures cluster, so re-sampling a different month often produces good ones. Each URL can only be resampled once per orchestrator run.',
      inputSchema: jsonSchema<{ url: string; count: number; since?: string; until?: string }>({
        type: 'object',
        properties: {
          url: { type: 'string' },
          count: { type: 'integer', minimum: 1, maximum: 8 },
          since: { type: 'string', description: 'ISO date lower bound' },
          until: { type: 'string', description: 'ISO date upper bound' },
        },
        required: ['url', 'count'],
      }),
      execute: async ({ url, count, since, until }) => {
        if (state.resamples.has(url)) {
          return { error: `already resampled ${url} — skip and conclude or retry individual targets instead` }
        }
        if (overBudget(state)) return { error: 'cost cap reached — conclude job' }
        const action: ResampleAction = { url, count, since, until, attempted: true }
        state.resamples.set(url, action)
        if (verbose) console.log(`  [orchestrator] resampleWayback ${url} count=${count}`)

        try {
          const targets = await discoverWaybackSnapshots(url, { count, since, until })
          if (targets.length === 0) return { added: 0, error: 'CDX returned zero captures for that window' }
          // De-dupe against snapshots we already audited.
          const existing = new Set(state.job.results.map(r => r.snapshotUrl ?? r.url))
          const fresh: JobTarget[] = targets.filter(t => !existing.has(t.snapshotUrl ?? t.url))
          if (fresh.length === 0) return { added: 0, note: 'all sampled snapshots were already audited; widen the window or pick a different URL' }
          state.job.targets.push(...fresh)
          // Run only the new targets through the queue with resume=true.
          await runJob(state.job, { auditFn: opts.auditFn, dir: opts.dir, resume: true })
          const newOk = fresh.filter(t => state.job.results.some(r => (r.snapshotUrl ?? r.url) === (t.snapshotUrl ?? t.url) && r.status === 'ok')).length
          return { added: fresh.length, newlyOk: newOk, totalCostUSD: state.job.totalCostUSD }
        } catch (err) {
          return { error: (err as Error).message }
        }
      },
    }),

    retryTarget: tool({
      description: 'Re-attempt a single failed or skipped target. Use only for transient failures. Hard cap: 2 retries per target per orchestrator run.',
      inputSchema: jsonSchema<{ url: string; snapshotUrl?: string }>({
        type: 'object',
        properties: {
          url: { type: 'string' },
          snapshotUrl: { type: 'string' },
        },
        required: ['url'],
      }),
      execute: async ({ url, snapshotUrl }) => {
        const key = snapshotUrl ?? url
        const used = state.retries.get(key) ?? 0
        if (used >= 2) return { error: `retry budget for ${key} exhausted (2 used)` }
        if (overBudget(state)) return { error: 'cost cap reached — conclude job' }
        state.retries.set(key, used + 1)
        if (verbose) console.log(`  [orchestrator] retryTarget ${key} attempt=${used + 1}`)
        // Drop the existing failed/skipped entry, then resume — the queue will pick the missing target up.
        state.job.results = state.job.results.filter(r => (r.snapshotUrl ?? r.url) !== key)
        await runJob(state.job, { auditFn: opts.auditFn, dir: opts.dir, resume: true })
        const newEntry = state.job.results.find(r => (r.snapshotUrl ?? r.url) === key)
        return { status: newEntry?.status ?? 'unknown', error: newEntry?.error, totalCostUSD: state.job.totalCostUSD }
      },
    }),

    markSkipped: tool({
      description: 'Terminally mark a target as skipped (no further retries). Use for structurally unfixable failures — persistent 4xx, anti-bot, dead URL.',
      inputSchema: jsonSchema<{ url: string; snapshotUrl?: string; reason: string }>({
        type: 'object',
        properties: {
          url: { type: 'string' },
          snapshotUrl: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['url', 'reason'],
      }),
      execute: async ({ url, snapshotUrl, reason }) => {
        const key = snapshotUrl ?? url
        const idx = state.job.results.findIndex(r => (r.snapshotUrl ?? r.url) === key)
        if (idx >= 0) {
          state.job.results[idx] = { ...state.job.results[idx], status: 'skipped', error: reason }
        } else {
          state.job.results.push({ url, snapshotUrl, status: 'skipped', error: reason })
        }
        saveJob(state.job, opts.dir)
        if (verbose) console.log(`  [orchestrator] markSkipped ${key}: ${reason}`)
        return { ok: true }
      },
    }),

    concludeJob: tool({
      description: 'End the orchestrator loop. Provide a one-sentence reason summarizing the final state.',
      inputSchema: jsonSchema<{ reason: string }>({
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      }),
      execute: async ({ reason }) => {
        state.concluded = true
        state.reason = reason
        if (verbose) console.log(`  [orchestrator] concludeJob: ${reason}`)
        return { concluded: true }
      },
    }),
  } as const
}

function overBudget(state: OrchestratorState): boolean {
  const cap = state.job.spec.maxCostUSD
  if (typeof cap !== 'number') return false
  // Leave 10% headroom so the next single audit doesn't push us over.
  return state.job.totalCostUSD >= cap * 0.9
}

/** Re-export for tests / callers that want to inspect what would have run. */
export { needsIntervention }

function defaultBrain(): Brain {
  const provider = 'claude-code' as SupportedProvider
  const model = resolveProviderModelName(provider)
  const apiKey = resolveProviderApiKey(provider)
  return new Brain({ provider, model, apiKey, vision: false, llmTimeoutMs: 60_000 })
}
