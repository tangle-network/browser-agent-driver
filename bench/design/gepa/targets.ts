/**
 * GEPA targets for the design-audit pipeline.
 *
 * A "target" is a single knob the loop is allowed to mutate this run.
 * Variants of the same target carry payloads that this module knows how to
 * compile into an `AuditOverrides` value.
 *
 * Add a new target by:
 *   1. extending `GepaTargetId` in ./types.ts
 *   2. implementing `seedFor(target)` and `compileOverrides(target, payload)`
 *   3. (optional) adding a default seed payload below
 */

import { createHash } from 'node:crypto'
import {
  PASS_DEFINITIONS,
  DEFAULT_NO_BS_RULES,
  DEFAULT_CONSERVATIVE_WEIGHTS,
  DEFAULT_DEEP_PASSES_BY_TYPE,
  DEFAULT_FEW_SHOT_EXAMPLES,
  type AuditOverrides,
  type AuditPass,
  type AuditPassId,
} from '../../../src/design/audit/evaluate.js'
import { DEFAULT_PATCH_SYNTHESIS_CONFIG, type PatchSynthesisConfig } from '../../../src/design/audit/patches/generate.js'
import type { GepaTargetId, PromptVariant } from './types.js'

export const KNOWN_TARGETS: GepaTargetId[] = [
  'pass-focus',
  'few-shot-example',
  'no-bs-rules',
  'conservative-score-weights',
  'pass-selection-per-classification',
  'infer-audit-mode',
  'patch-synthesis-signature',
]

export interface SeedSpec {
  variant: PromptVariant
  /** Variant id of the canonical default — used as the baseline reference. */
  isCanonicalDefault: boolean
}

export function seedFor(target: GepaTargetId): SeedSpec {
  switch (target) {
    case 'pass-focus':
      return defaultVariant(target, 'pass-focus:default', 'Default PASS_DEFINITIONS', PASS_DEFINITIONS)
    case 'few-shot-example':
      return defaultVariant(target, 'few-shot-example:default', 'Default few-shot examples per pass', DEFAULT_FEW_SHOT_EXAMPLES)
    case 'no-bs-rules':
      return defaultVariant(target, 'no-bs-rules:default', 'Default 6 NO-BS rules', { rules: DEFAULT_NO_BS_RULES })
    case 'conservative-score-weights':
      return defaultVariant(target, 'cons-weights:default', 'Default 0.65 min / 0.35 mean', DEFAULT_CONSERVATIVE_WEIGHTS)
    case 'pass-selection-per-classification':
      return defaultVariant(target, 'deep-passes:default', 'Default deep-pass bundles per page type', DEFAULT_DEEP_PASSES_BY_TYPE)
    case 'infer-audit-mode':
      return defaultVariant(target, 'infer-mode:default', 'Default inferAuditMode mappings', defaultInferAuditModeTable())
    case 'patch-synthesis-signature':
      return defaultVariant(target, 'patch-synthesis:default', 'Default patch synthesis signature', DEFAULT_PATCH_SYNTHESIS_CONFIG)
  }
}

function defaultVariant(target: GepaTargetId, id: string, label: string, payload: unknown): SeedSpec {
  return {
    isCanonicalDefault: true,
    variant: {
      id,
      target,
      hash: hashPayload(payload),
      payload,
      label,
      generation: 0,
      rationale: 'baseline',
    },
  }
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12)
}

/**
 * Compile a variant's payload into `AuditOverrides`. Each target knows how to
 * interpret its own payload. Unknown payload shapes return an empty override
 * (the audit falls back to the canonical defaults — fail-soft).
 */
export function compileOverrides(variant: PromptVariant): AuditOverrides {
  switch (variant.target) {
    case 'pass-focus': {
      const payload = variant.payload as Partial<Record<AuditPassId, AuditPass>>
      return { passDefinitions: payload }
    }
    case 'few-shot-example': {
      const payload = variant.payload as Partial<Record<AuditPassId, string>>
      return { fewShotExamples: payload }
    }
    case 'no-bs-rules': {
      const payload = variant.payload as { rules: string[] }
      return { noBsRules: payload.rules }
    }
    case 'conservative-score-weights': {
      const payload = variant.payload as { min: number; mean: number }
      return { conservativeWeights: payload }
    }
    case 'pass-selection-per-classification': {
      const payload = variant.payload as Record<string, AuditPassId[]>
      return { deepPassesByPageType: payload as AuditOverrides['deepPassesByPageType'] }
    }
    case 'infer-audit-mode': {
      // Payload is a flat lookup table keyed by classification predicate. We
      // synthesise a function that walks the table in order.
      const payload = variant.payload as InferAuditModeTable
      return {
        inferAuditMode: (classification) => {
          const domain = classification.domain.toLowerCase()
          for (const entry of payload) {
            if (entry.match === 'type') {
              if (classification.type === entry.value) return entry.text
            } else if (entry.match === 'domain') {
              if (new RegExp(entry.value, 'i').test(domain)) return entry.text
            } else if (entry.match === 'default') {
              return entry.text
            }
          }
          return 'General product surface. Judge whether the page makes its audience, purpose, state, and next action obvious, then evaluate visual craft in service of that job.'
        },
      }
    }
    case 'patch-synthesis-signature': {
      const payload = variant.payload as PatchSynthesisConfig
      return { patchSynthesis: normalizePatchSynthesis(payload) }
    }
  }
}

function normalizePatchSynthesis(payload: PatchSynthesisConfig): PatchSynthesisConfig {
  const fallback = DEFAULT_PATCH_SYNTHESIS_CONFIG
  return {
    system: typeof payload.system === 'string' && payload.system.trim() ? payload.system : fallback.system,
    groundingRules: Array.isArray(payload.groundingRules) && payload.groundingRules.length > 0
      ? payload.groundingRules.filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0)
      : fallback.groundingRules,
    ...(Array.isArray(payload.examples)
      ? { examples: payload.examples.filter((example): example is string => typeof example === 'string' && example.trim().length > 0) }
      : {}),
  }
}

export type InferAuditModeTable = Array<
  | { match: 'domain'; value: string; text: string }
  | { match: 'type'; value: string; text: string }
  | { match: 'default'; value: ''; text: string }
>

/**
 * Default mappings — kept as data so the variant payload is a JSON-serialisable
 * shape. The runtime function in evaluate.ts is the canonical source; this is
 * the data form GEPA mutates.
 */
function defaultInferAuditModeTable(): InferAuditModeTable {
  return [
    { match: 'domain', value: '(crypto|defi|web3|wallet|payments?|finance|fintech|banking)', text: 'High-trust transactional product. Judge transaction clarity, trust, risk, provenance, verification, and whether users understand what they are committing to before they act.' },
    { match: 'domain', value: '(devtools?|developer|infrastructure|api|sdk|cloud|hosting|deploy|database|observability)', text: 'Developer/operator product. Judge whether the UI exposes real operational objects, status, logs, source, commands, deploy paths, and debugging affordances instead of generic dashboard filler.' },
    { match: 'domain', value: '(ai|ml|llm|agent|model|inference|training)', text: 'AI/ML product. Judge whether model capability, latency/cost, job state, inputs/outputs, safety limits, and failure recovery are concrete and usable.' },
    { match: 'domain', value: '(health|medical|clinical|legal|insurance)', text: 'High-stakes professional product. Judge clarity, safety, auditability, error prevention, and whether the UI avoids ambiguous or decorative communication.' },
    { match: 'type', value: 'ecommerce', text: 'Commerce product. Judge product comprehension, comparison, price/fees, checkout confidence, inventory/delivery signals, and purchase path clarity.' },
    { match: 'type', value: 'docs', text: 'Documentation product. Judge information scent, quickstart path, examples, API/reference scanability, versioning, and whether readers can get unstuck quickly.' },
    { match: 'type', value: 'marketing', text: 'Marketing/conversion product. Judge whether the page makes the offer, audience, proof, differentiation, and next step obvious without vague hype.' },
    { match: 'default', value: '', text: 'General product surface. Judge whether the page makes its audience, purpose, state, and next action obvious, then evaluate visual craft in service of that job.' },
  ]
}
