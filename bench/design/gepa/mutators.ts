/**
 * Reflective-mutation adapters.
 *
 * For each target, we provide a ReflectiveMutator that takes (parent variant,
 * top trials, bottom trials) and produces N child variants by asking an LLM
 * to propose mutations conditioned on the trace evidence.
 *
 * In addition we provide a deterministic fallback mutator per target — used
 * for `--mutator deterministic` and inside tests so the loop is verifiable
 * without an LLM. The fallback applies a small set of canonical perturbations
 * (e.g. "rephrase the focus more aggressively", "swap weights toward
 * recall") so the loop can be exercised end-to-end with no provider.
 */

import { randomUUID } from 'node:crypto'
import type { Brain } from '../../../src/brain/index.js'
import type { AuditPass, AuditPassId } from '../../../src/design/audit/evaluate.js'
import type { MutateAdapter } from './loop.js'
import { hashPayload } from './targets.js'
import type { GepaTargetId, PromptVariant, TrialResult, VariantSummary } from './types.js'

export interface MutationContext {
  parent: PromptVariant
  topTrials: TrialResult[]
  bottomTrials: TrialResult[]
  parentSummary: VariantSummary
  childCount: number
  generation: number
}

/** Mutator that uses an LLM for reflective proposal. */
export class ReflectiveMutator implements MutateAdapter {
  constructor(private readonly brain: Brain, private readonly target: GepaTargetId) {}

  async mutate(ctx: MutationContext): Promise<PromptVariant[]> {
    const prompt = buildReflectionPrompt(this.target, ctx)
    const result = await this.brain.complete(
      'You are a meta-prompt engineer. Output ONLY the requested JSON, no prose, no markdown fences.',
      prompt,
      { maxOutputTokens: 2400 },
    )
    return parseProposals(this.target, result.text, ctx).slice(0, ctx.childCount)
  }
}

/** Deterministic fallback — no LLM. Useful for smoke tests + cheap CI. */
export class DeterministicMutator implements MutateAdapter {
  constructor(private readonly target: GepaTargetId) {}

  async mutate(ctx: MutationContext): Promise<PromptVariant[]> {
    return deterministicProposals(this.target, ctx).slice(0, ctx.childCount)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Reflective prompt + parsing
// ────────────────────────────────────────────────────────────────────────────

function buildReflectionPrompt(target: GepaTargetId, ctx: MutationContext): string {
  const top = ctx.topTrials.slice(0, 3).map(traceLine).join('\n')
  const bot = ctx.bottomTrials.slice(0, 3).map(traceLine).join('\n')
  return `You are tuning the prompt for a design-audit LLM. The component being
mutated is the \`${target}\` target. The current variant is shown below; you
will see top and bottom trials so you can reason about what to change.

CURRENT VARIANT (id: ${ctx.parent.id}):
${JSON.stringify(ctx.parent.payload, null, 2)}

TOP TRIALS (high recall + score):
${top || '(none)'}

BOTTOM TRIALS (low recall or wrong score):
${bot || '(none)'}

Propose ${ctx.childCount} mutations. Each mutation should target a SPECIFIC
weakness visible in the bottom trials. Avoid blank rephrasings.

OUTPUT — JSON only:
{"proposals":[{"label":"<short label>","rationale":"<why>","payload":<full payload of the new variant>}]}
`
}

function traceLine(t: TrialResult): string {
  const goldenHit = t.goldenMatches.filter(Boolean).length
  const goldenTot = t.goldenMatches.length
  return `- fixture=${t.fixtureId} rep=${t.rep} score=${t.score} recall=${goldenHit}/${goldenTot} findings=${t.findings.length} ok=${t.ok}`
}

function parseProposals(
  target: GepaTargetId,
  raw: string,
  ctx: MutationContext,
): PromptVariant[] {
  let text = raw.trim()
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { proposals?: unknown[] }
    if (!Array.isArray(parsed.proposals)) return []
    return parsed.proposals
      .filter((p): p is { label?: string; rationale?: string; payload: unknown } => typeof p === 'object' && p !== null && 'payload' in p)
      .map((p) => ({
        id: `${target}-${randomUUID().slice(0, 8)}`,
        target,
        hash: hashPayload(p.payload),
        payload: p.payload,
        label: typeof p.label === 'string' ? p.label : `${target} mutation`,
        generation: ctx.generation,
        parentId: ctx.parent.id,
        rationale: typeof p.rationale === 'string' ? p.rationale : 'reflective mutation',
      }))
  } catch {
    return []
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic proposals (no LLM)
// ────────────────────────────────────────────────────────────────────────────

function deterministicProposals(target: GepaTargetId, ctx: MutationContext): PromptVariant[] {
  const proposals: PromptVariant[] = []
  switch (target) {
    case 'conservative-score-weights': {
      const grid: Array<{ min: number; mean: number; label: string }> = [
        { min: 0.5, mean: 0.5, label: 'balanced 50/50' },
        { min: 0.7, mean: 0.3, label: 'pessimistic 70/30' },
        { min: 0.8, mean: 0.2, label: 'pessimistic 80/20' },
        { min: 0.4, mean: 0.6, label: 'mean-leaning 40/60' },
      ]
      for (const g of grid) {
        proposals.push(makeVariant(target, ctx.generation, ctx.parent.id, { min: g.min, mean: g.mean }, g.label, `swap min/mean weights to ${g.min}/${g.mean}`))
      }
      break
    }
    case 'no-bs-rules': {
      const parent = (ctx.parent.payload as { rules: string[] }).rules ?? []
      proposals.push(
        makeVariant(target, ctx.generation, ctx.parent.id, { rules: parent.concat(['Surface every dead-end interactive control as a workflow defect.']) }, 'add dead-end rule', 'patch a workflow gap'),
        makeVariant(target, ctx.generation, ctx.parent.id, { rules: parent.filter((r) => !/could benefit/i.test(r)) }, 'drop softener guard', 'remove redundant rule'),
      )
      break
    }
    case 'pass-focus': {
      const parent = ctx.parent.payload as Partial<Record<AuditPassId, AuditPass>>
      const sharper: Partial<Record<AuditPassId, AuditPass>> = { ...parent }
      const product = parent.product
      if (product) {
        sharper.product = {
          ...product,
          instructions:
            product.instructions +
            ' If the page would belong to any startup after swapping nouns, that itself is a critical product defect — call it out before any visual finding.',
        }
      }
      proposals.push(makeVariant(target, ctx.generation, ctx.parent.id, sharper, 'sharper product pass', 'amplify product-specificity rule'))
      break
    }
    case 'pass-selection-per-classification': {
      const parent = ctx.parent.payload as Record<string, AuditPassId[]>
      proposals.push(makeVariant(target, ctx.generation, ctx.parent.id, { ...parent, 'saas-app': ['product', 'workflow', 'visual'] }, 'saas-app: product+workflow', 'workflow weight on saas'))
      break
    }
    case 'few-shot-example':
    case 'infer-audit-mode':
      // No safe deterministic perturbation — leave to reflective mutator.
      break
  }
  return proposals
}

function makeVariant(
  target: GepaTargetId,
  generation: number,
  parentId: string,
  payload: unknown,
  label: string,
  rationale: string,
): PromptVariant {
  return {
    id: `${target}-${randomUUID().slice(0, 8)}`,
    target,
    hash: hashPayload(payload),
    payload,
    label,
    generation,
    parentId,
    rationale,
  }
}
