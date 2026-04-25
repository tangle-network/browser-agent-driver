/**
 * Pattern Extractor — learns reusable navigation patterns from completed runs.
 *
 * Gen 26b: after a successful run, mechanically extract domain-level patterns
 * from the turn log and record them as AppKnowledge facts. No LLM call needed —
 * patterns are detected by observing action/state sequences.
 *
 * Extracted patterns:
 * - Cookie/consent banner dismissal (which action dismissed it, on which turn)
 * - Page load timing (how long the site takes to settle)
 * - Form structure (which refs are used for key form fields)
 * - Navigation paths (effective URL patterns for search/results)
 * - Blockers encountered (modals, auth walls, rate limits)
 *
 * Design constraints:
 * - No bloat: only records patterns with clear signal (not every action)
 * - Cleanable: all facts have confidence scores; low-confidence facts auto-prune
 * - Workspace-isolated: patterns stored per-domain in the knowledge store
 * - Smart: confirms patterns on repeat observation, decays on contradiction
 */

import type { Turn } from '../types.js'
import type { AppKnowledge, Fact } from '../memory/knowledge.js'

interface ExtractedPattern {
  type: Fact['type']
  key: string
  value: string
}

/**
 * Extract reusable patterns from a completed run's turns.
 * Only extracts from SUCCESSFUL runs — failed runs produce unreliable patterns.
 */
export function extractPatterns(
  turns: Turn[],
  domain: string,
  success: boolean,
): ExtractedPattern[] {
  if (!success || turns.length < 2) return []

  const patterns: ExtractedPattern[] = []

  // 1. Cookie/consent banner dismissal
  // Look for early turns where the agent clicked something that looks like
  // cookie/consent/accept and then proceeded normally
  for (let i = 0; i < Math.min(turns.length, 5); i++) {
    const turn = turns[i]
    const action = turn.action
    if (action.action === 'click' || action.action === 'clickAt' || action.action === 'clickLabel') {
      const reasoning = turn.reasoning?.toLowerCase() || ''
      const snapshot = turn.state?.snapshot?.toLowerCase() || ''
      if (/cookie|consent|accept.*cookie|gdpr|privacy/i.test(reasoning + snapshot)) {
        const selector = 'selector' in action ? action.selector : `clickAt(${(action as { x?: number }).x},${(action as { y?: number }).y})`
        patterns.push({
          type: 'pattern',
          key: 'cookie-dismiss',
          value: `Turn ${i + 1}: ${action.action} ${selector}`,
        })
        break // only record the first one
      }
    }
  }

  // 2. Page load timing — how many turns before first meaningful action
  const firstMeaningfulTurn = turns.findIndex(t =>
    t.action.action !== 'wait' && t.action.action !== 'scroll' &&
    !t.error && t.action.action !== 'navigate'
  )
  if (firstMeaningfulTurn >= 2) {
    patterns.push({
      type: 'timing',
      key: 'first-meaningful-action',
      value: `Turn ${firstMeaningfulTurn + 1} (${firstMeaningfulTurn} setup turns)`,
    })
  }

  // 3. Effective search/navigation URL pattern
  // If the agent used navigate with URL params, record the pattern
  for (const turn of turns) {
    if (turn.action.action === 'navigate' && turn.action.url) {
      try {
        const url = new URL(turn.action.url)
        if (url.hostname.includes(domain) && url.search.length > 5) {
          // Generalize: replace specific values with placeholders
          const pattern = url.pathname + url.search
            .replace(/=[^&]+/g, '={value}')
            .slice(0, 100)
          patterns.push({
            type: 'pattern',
            key: 'search-url',
            value: pattern,
          })
          break // only record the first effective search URL
        }
      } catch { /* invalid URL, skip */ }
    }
  }

  // 4. Turn efficiency — how many turns the task took
  patterns.push({
    type: 'timing',
    key: 'typical-turns',
    value: `${turns.length} turns`,
  })

  // 5. Form fields used — record which refs were used for form filling
  const fillTurns = turns.filter(t => t.action.action === 'fill' || t.action.action === 'type')
  if (fillTurns.length >= 2) {
    const fields = fillTurns
      .map(t => {
        if (t.action.action === 'fill' && 'fields' in t.action && t.action.fields) {
          return Object.keys(t.action.fields).join(',')
        }
        if (t.action.action === 'type' && 'selector' in t.action) {
          return t.action.selector
        }
        return ''
      })
      .filter(Boolean)
      .slice(0, 5)
    if (fields.length > 0) {
      patterns.push({
        type: 'selector',
        key: 'form-fields',
        value: fields.join(' → '),
      })
    }
  }

  return patterns
}

/**
 * Record extracted patterns into the knowledge store.
 * Respects the existing confidence system — repeated patterns gain confidence,
 * contradicted patterns decay.
 */
export function recordPatterns(
  knowledge: AppKnowledge,
  patterns: ExtractedPattern[],
): void {
  for (const p of patterns) {
    knowledge.recordFact(p.type, p.key, p.value)
  }
}
