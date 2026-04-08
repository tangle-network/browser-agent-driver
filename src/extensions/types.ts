/**
 * Extension API for user customization.
 *
 * Users supply a `bad.config.{js,mjs,ts}` file in the cwd (or pass
 * `--extension <path>`) to augment the agent without forking. Extensions
 * can:
 *
 *   - Subscribe to TurnEvents (observe everything bad does in real time)
 *   - Mutate decisions before execute (override the agent's choice)
 *   - Add rules to specific system-prompt sections (search, dataExtraction,
 *     heavy, reasoning) without overwriting the whole prompt
 *   - Add per-domain rules that fire only on matching URLs
 *   - Register custom design-audit rubric fragments programmatically
 *
 * The API is intentionally narrow: it surfaces the levers we know users
 * need without creating a sprawling plugin surface that's hard to evolve.
 *
 * Example bad.config.mjs:
 *
 *   export default {
 *     addRules: {
 *       dataExtraction: 'When extracting prices, always include the currency symbol.',
 *     },
 *     addRulesForDomain: {
 *       'stripe.com': {
 *         extraRules: 'On stripe.com, prefer the Dashboard nav over the marketing site search.',
 *       },
 *     },
 *     addAuditFragments: [
 *       {
 *         id: 'crypto-trust-signals',
 *         dimension: 'trust',
 *         weight: 'high',
 *         appliesWhen: { domain: ['crypto'] },
 *         body: 'Score crypto-app trust signals: cert badges, SOC2, audit reports, founders.',
 *       },
 *     ],
 *     onTurnEvent(event) {
 *       if (event.type === 'execute-completed' && !event.success) {
 *         console.log('Action failed:', event.error)
 *       }
 *     },
 *   }
 */

import type { TurnEvent } from '../runner/events.js'
import type { BrainDecision } from '../brain/index.js'
import type { PageState, Action } from '../types.js'
import type { RubricFragment, AppliesWhen } from '../design/audit/types.js'

/** Context passed to mutateDecision so the hook can make informed choices. */
export interface DecisionContext {
  goal: string
  turn: number
  maxTurns: number
  state: PageState
  /** Latest action error, if the previous turn failed */
  lastError?: string
}

/** Per-section rule additions for the system prompt. */
export interface SectionRules {
  /** Appended after CORE_RULES + REASONING_SUFFIX */
  global?: string
  /** Added when the page has search affordances */
  search?: string
  /** Added when the goal mentions data extraction */
  dataExtraction?: string
  /** Added on large snapshots or late turns */
  heavy?: string
}

/** Per-domain rule injection. The domain is matched as a substring of the URL host. */
export interface DomainRules {
  extraRules?: string
}

/**
 * The user's extension shape. Every field is optional. Extensions are loaded
 * from `bad.config.{js,mjs,ts}` in the cwd, or via the `--extension` CLI
 * flag.
 */
export interface BadExtension {
  /** Subscribe to every TurnEvent emitted by the runner */
  onTurnEvent?: (event: TurnEvent) => void

  /**
   * Mutate the agent's decision before execute. Return the new decision or
   * void to leave it unchanged. Mutations are logged as override events.
   *
   * Use cases: enforce per-app safety rules ("never click delete"), inject
   * synthetic actions ("always start with a screenshot"), or veto decisions
   * that would violate a domain constraint.
   */
  mutateDecision?: (
    decision: BrainDecision,
    ctx: DecisionContext,
  ) => BrainDecision | void

  /** Append rules to specific system-prompt sections without overwriting CORE_RULES */
  addRules?: SectionRules

  /**
   * Domain-keyed extra rules. Keys are matched as substrings of the URL host
   * (e.g., 'stripe.com' matches 'dashboard.stripe.com' and 'stripe.com/docs').
   */
  addRulesForDomain?: Record<string, DomainRules>

  /** Programmatic rubric fragments for design audits (same shape as on-disk fragments) */
  addAuditFragments?: Array<
    Pick<RubricFragment, 'id' | 'title' | 'weight' | 'body'> & {
      dimension?: string
      appliesWhen?: AppliesWhen
    }
  >
}

/**
 * Multi-extension result: combine N user extensions into a single object.
 * Listeners fan out, addRules sections concatenate, etc.
 */
export interface ResolvedExtensions {
  extensions: BadExtension[]
  fanOutTurnEvent: (event: TurnEvent) => void
  applyMutateDecision: (
    decision: BrainDecision,
    ctx: DecisionContext,
  ) => { decision: BrainDecision; mutated: boolean; sources: string[] }
  combinedRules: SectionRules
  combinedDomainRules: Record<string, DomainRules>
  combinedAuditFragments: BadExtension['addAuditFragments']
}

/**
 * Combine N extensions into a single resolved object. The runner uses the
 * resolved form so it doesn't iterate the extension list on every turn.
 */
export function resolveExtensions(extensions: BadExtension[]): ResolvedExtensions {
  const combinedRules: SectionRules = {}
  const combinedDomainRules: Record<string, DomainRules> = {}
  const combinedAuditFragments: NonNullable<BadExtension['addAuditFragments']> = []

  for (const ext of extensions) {
    if (ext.addRules) {
      for (const key of ['global', 'search', 'dataExtraction', 'heavy'] as const) {
        const value = ext.addRules[key]
        if (value) {
          combinedRules[key] = combinedRules[key]
            ? `${combinedRules[key]}\n\n${value}`
            : value
        }
      }
    }
    if (ext.addRulesForDomain) {
      for (const [domain, rules] of Object.entries(ext.addRulesForDomain)) {
        const existing = combinedDomainRules[domain]
        if (existing && rules.extraRules) {
          existing.extraRules = `${existing.extraRules ?? ''}\n\n${rules.extraRules}`.trim()
        } else if (rules.extraRules) {
          combinedDomainRules[domain] = { extraRules: rules.extraRules }
        }
      }
    }
    if (ext.addAuditFragments) {
      combinedAuditFragments.push(...ext.addAuditFragments)
    }
  }

  return {
    extensions,
    fanOutTurnEvent: (event) => {
      for (const ext of extensions) {
        if (ext.onTurnEvent) {
          try {
            ext.onTurnEvent(event)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[bad-extension] onTurnEvent threw:', err)
          }
        }
      }
    },
    applyMutateDecision: (decision, ctx) => {
      let current = decision
      let mutated = false
      const sources: string[] = []
      for (let idx = 0; idx < extensions.length; idx++) {
        const ext = extensions[idx]
        if (!ext.mutateDecision) continue
        try {
          const result = ext.mutateDecision(current, ctx)
          if (result && result.action !== current.action) {
            current = result
            mutated = true
            sources.push(`extension[${idx}]`)
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[bad-extension] mutateDecision threw:', err)
        }
      }
      return { decision: current, mutated, sources }
    },
    combinedRules,
    combinedDomainRules,
    combinedAuditFragments: combinedAuditFragments.length > 0 ? combinedAuditFragments : undefined,
  }
}

/**
 * Pick the per-domain rules that apply to a given URL. Returns the
 * concatenation of every matching domain's extraRules, in registration order.
 */
export function rulesForUrl(
  url: string,
  domainRules: Record<string, DomainRules>,
): string | undefined {
  const matches: string[] = []
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  for (const [domain, rules] of Object.entries(domainRules)) {
    if (host.includes(domain) && rules.extraRules) {
      matches.push(rules.extraRules)
    }
  }
  return matches.length > 0 ? matches.join('\n\n') : undefined
}

/** Type-guard for extension shape (used by the loader) */
export function isBadExtension(value: unknown): value is BadExtension {
  if (!value || typeof value !== 'object') return false
  const ext = value as Record<string, unknown>
  // Empty objects are valid extensions (a no-op extension is a valid one).
  // Non-function values for hook fields are invalid.
  if (ext.onTurnEvent !== undefined && typeof ext.onTurnEvent !== 'function') return false
  if (ext.mutateDecision !== undefined && typeof ext.mutateDecision !== 'function') return false
  if (ext.addRules !== undefined && (typeof ext.addRules !== 'object' || ext.addRules === null)) return false
  if (ext.addRulesForDomain !== undefined && (typeof ext.addRulesForDomain !== 'object' || ext.addRulesForDomain === null)) return false
  if (ext.addAuditFragments !== undefined && !Array.isArray(ext.addAuditFragments)) return false
  return true
}

// Re-exports for ergonomic imports from outside the package
export type { TurnEvent, BrainDecision, PageState, Action, RubricFragment, AppliesWhen }
