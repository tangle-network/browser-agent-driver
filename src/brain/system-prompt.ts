/**
 * Dynamic system-prompt assembly for the Brain decision engine: conditional
 * rule-group injection (search / data-extraction / heavy-page), user + domain
 * + macro rule appends, and the Anthropic cache_control split used by
 * `decide()`.
 *
 * Extracted from brain/index.ts via the delegate + host-interface pattern.
 * `buildSystemForDecide` keeps a thin delegator on Brain; the other three
 * helpers moved wholesale. Bodies are verbatim — same ordering, thresholds,
 * and byte-stable cached-prefix placement. State is read through
 * {@link BrainSystemPromptHost}, which Brain `implements`.
 */

import type { SystemModelMessage } from 'ai';
import type { PageState } from '../types.js';
import {
  CORE_RULES,
  SEARCH_RULES,
  DATA_EXTRACTION_RULES,
  HEAVY_PAGE_RULES,
  REASONING_SUFFIX,
  SYSTEM_PROMPT,
  DATA_EXTRACTION_PATTERN,
  SEARCH_SNAPSHOT_PATTERN,
} from './prompts.js';

/**
 * The slice of Brain state the system-prompt assembly reads. Brain declares
 * `implements BrainSystemPromptHost`, so tsc proves this surface is complete.
 * All members are public on Brain by construction.
 */
export interface BrainSystemPromptHost {
  systemPrompt: string;
  extensionRules?: { global?: string; search?: string; dataExtraction?: string; heavy?: string };
  extensionDomainRules?: Record<string, { extraRules?: string }>;
  macroPromptBlock: string;
}

/**
 * Build the system prompt dynamically, injecting conditional rule groups
 * based on goal text, page snapshot content, and turn number.
 * Saves ~800 tokens per turn on simple navigation tasks.
 */
export function buildSystemPromptImpl(self: BrainSystemPromptHost, goal: string, state: PageState, turn: number): string {
  return composeSystemPromptPartsImpl(self, goal, state, turn).join('')
}

/**
 * Same as buildSystemPrompt but returns the parts so the caller can decide
 * how to send them. For Anthropic, decide() ships them as a SystemModelMessage[]
 * with cache_control on the stable CORE_RULES prefix; other providers join.
 *
 * The first slot is ALWAYS CORE_RULES (or the user's custom override) so the
 * cache breakpoint placement is deterministic. Extension-supplied rules are
 * appended AFTER REASONING_SUFFIX so the cached prefix stays byte-stable
 * across turns.
 */
export function composeSystemPromptPartsImpl(self: BrainSystemPromptHost, goal: string, state: PageState, turn: number): string[] {
  if (self.systemPrompt !== SYSTEM_PROMPT) return [self.systemPrompt]

  const parts: string[] = [CORE_RULES]
  const snapshotSample = state.snapshot.length > 4000 ? state.snapshot.slice(0, 4000) : state.snapshot
  if (SEARCH_SNAPSHOT_PATTERN.test(snapshotSample) || /\/search\b/i.test(state.url)) {
    parts.push(SEARCH_RULES)
    if (self.extensionRules?.search) {
      parts.push(`\n\nUSER RULES (search):\n${self.extensionRules.search}`)
    }
  }
  if (DATA_EXTRACTION_PATTERN.test(goal)) {
    parts.push(DATA_EXTRACTION_RULES)
    if (self.extensionRules?.dataExtraction) {
      parts.push(`\n\nUSER RULES (data extraction):\n${self.extensionRules.dataExtraction}`)
    }
  }
  if (state.snapshot.length > 10_000 || turn > 10) {
    parts.push(HEAVY_PAGE_RULES)
    if (self.extensionRules?.heavy) {
      parts.push(`\n\nUSER RULES (heavy page):\n${self.extensionRules.heavy}`)
    }
  }
  parts.push(REASONING_SUFFIX)

  // Global user rules + matching per-domain rules. Both are appended AFTER
  // REASONING_SUFFIX so they don't pollute the byte-stable cached prefix.
  if (self.extensionRules?.global) {
    parts.push(`\n\nUSER RULES (global):\n${self.extensionRules.global}`)
  }
  if (self.extensionDomainRules) {
    const domainRules = matchDomainRulesImpl(self, state.url)
    if (domainRules) {
      parts.push(`\n\nUSER RULES (domain match):\n${domainRules}`)
    }
  }
  // Macros live AFTER the cached prefix so registering new macros
  // doesn't bust the Anthropic cache.
  if (self.macroPromptBlock) {
    parts.push(`\n\n${self.macroPromptBlock}`)
  }
  return parts
}

/**
 * Find the per-domain extra rules whose domain key matches the URL host.
 * Multiple matches are concatenated in registration order.
 */
export function matchDomainRulesImpl(self: BrainSystemPromptHost, url: string): string | undefined {
  if (!self.extensionDomainRules) return undefined
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return undefined
  }
  const matches: string[] = []
  for (const [domain, rules] of Object.entries(self.extensionDomainRules)) {
    if (host.includes(domain) && rules.extraRules) {
      matches.push(rules.extraRules)
    }
  }
  return matches.length > 0 ? matches.join('\n\n') : undefined
}

/**
 * Build the system prompt for `decide()` in the form best suited to the
 * active provider:
 *   - Anthropic: a SystemModelMessage[] with `cache_control: ephemeral`
 *     on the CORE_RULES slot. Subsequent turns get a cache hit on the
 *     ~1500-token prefix (90% cheaper input + faster TTFT).
 *   - Everything else: a single concatenated string (current behavior).
 *
 * Custom system prompts (set via config) are passed verbatim — caching
 * is opt-in via the default prompt path only.
 */
export function buildSystemForDecideImpl(
  self: BrainSystemPromptHost,
  goal: string,
  state: PageState,
  turn: number,
  providerName: 'openai' | 'anthropic' | 'google' | 'cli-bridge' | 'codex-cli' | 'claude-code' | 'sandbox-backend' | 'zai-coding-plan',
): string | SystemModelMessage[] {
  const parts = composeSystemPromptPartsImpl(self, goal, state, turn)
  if (providerName !== 'anthropic' || self.systemPrompt !== SYSTEM_PROMPT || parts.length === 0) {
    return parts.join('')
  }
  // Anthropic path: first slot is CORE_RULES (cached), remaining parts ship
  // as a separate uncached system message so the prefix stays byte-stable
  // across turns and the cache hits.
  const corePart: SystemModelMessage = {
    role: 'system',
    content: parts[0],
    providerOptions: {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
      },
    },
  }
  if (parts.length === 1) return [corePart]
  return [corePart, { role: 'system', content: parts.slice(1).join('') }]
}
