/**
 * Observed-selector guard — fail-closed rejection of guessed CSS selectors.
 *
 * The top remaining failure class (bench wave 1): the model invents CSS
 * selectors for structure it cannot see (`div.metric-card:nth-child(1) >
 * div.metric-value`), the selector matches nothing, and it loops guessing
 * variants for 10-14 turns at 260-320k tokens per run.
 *
 * Rule: a selector on a driver-bound action is allowed iff it is
 *   - an @ref from the a11y snapshot, or
 *   - a documented fallback form (CORE_RULES SELECTOR FORMAT:
 *     [data-testid=...], [aria-label=...], text=, role=), or
 *   - 'body'/'html' (keyboard-escape conventions), or
 *   - present verbatim in the current observation, or
 *   - present in this run's prior evidence (script/extract output — the
 *   documented way to DISCOVER a real selector mid-run).
 * Anything else is a hallucinated selector and is rejected before execution
 * with an error that names the recovery path.
 */

import type { Action } from '../types.js';

const DOCUMENTED_FALLBACK = /^(?:\[data-testid=|\[aria-label=|text=|role=)/;
// The documented fallbacks must be the WHOLE selector. A combinator after
// the prefix (e.g. `[data-testid="dob"] input`) is a guessed CSS selector
// with a documented-looking head — prompt rule 15 bans it and the guard
// must agree.
const COMBINATOR_AFTER_PREFIX = /^(?:\[[^\]]+\]|role=\w+(?:\[[^\]]+\])?)\s/;
const STRUCTURAL_ALLOWLIST = new Set(['body', 'html']);

function selectorsOf(action: Action): string[] {
  const a = action as unknown as Record<string, unknown>;
  switch (action.action) {
    case 'click':
    case 'type':
    case 'hover':
    case 'select':
    case 'press':
      return typeof a.selector === 'string' ? [a.selector] : [];
    case 'fill': {
      const out: string[] = [];
      if (a.fields && typeof a.fields === 'object') out.push(...Object.keys(a.fields as object));
      if (a.selects && typeof a.selects === 'object') out.push(...Object.keys(a.selects as object));
      if (Array.isArray(a.checks)) out.push(...(a.checks as unknown[]).filter((c): c is string => typeof c === 'string'));
      return out;
    }
    case 'clickSequence':
      return Array.isArray(a.refs) ? (a.refs as unknown[]).filter((r): r is string => typeof r === 'string') : [];
    default:
      return [];
  }
}

/**
 * Returns an error message when the action carries a guessed CSS selector,
 * or null when every selector is accounted for by the observation, the
 * documented fallbacks, or the run's own evidence.
 */
export function validateObservedSelector(
  action: Action,
  snapshot: string,
  priorEvidence: string[],
): string | null {
  for (const selector of selectorsOf(action)) {
    if (!selector) continue;
    if (selector.startsWith('@')) continue;
    if (STRUCTURAL_ALLOWLIST.has(selector)) continue;
    if (COMBINATOR_AFTER_PREFIX.test(selector)) {
      return (
        `SELECTOR REJECTED: "${selector}" is a combinator with a documented-looking prefix — prompt rule 15 ` +
        `bans invented combinators. Use the bare [data-testid="..."] selector itself, an @ref from the ` +
        `ELEMENTS list, or extractWithIndex to find the inner element by content.`
      );
    }
    if (DOCUMENTED_FALLBACK.test(selector)) continue;
    if (snapshot.includes(selector)) continue;
    if (priorEvidence.some((entry) => entry.includes(selector))) continue;
    return (
      `SELECTOR REJECTED: "${selector}" is a guessed CSS selector — it appears nowhere in the current ` +
      `observation or in this run's script/extract results. Do NOT invent selectors. Use @refs or labels ` +
      `from the ELEMENTS list, the documented fallbacks ([data-testid="..."], [aria-label="..."], text=, ` +
      `role=), a selector your own runScript/extractWithIndex output returned, or call extractWithIndex ` +
      `with a wide query to discover the right target by content.`
    );
  }
  return null;
}
