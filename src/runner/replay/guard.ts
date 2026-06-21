/**
 * Workflow Replay — the pure pre-execution guard.
 *
 * Given a recorded {@link ReplayStep} and the current live observation (URL +
 * snapshot text only), decide whether the step can still be replayed against
 * the page in front of us. This module is PURE: no driver, no async, no IO. It
 * unit-tests with plain literals.
 *
 * It gates on ACTION-PERFORMABILITY, not snapshot identity (see the module note
 * in contracts.ts for why exact `snapshotHash` equality would heal on nearly
 * every replay):
 *   1. Origin consistency — the live page's origin must match the origin the
 *      step was recorded at (when both resolve). A recorded click on origin A
 *      must never fire while the live page sits on origin B.
 *   2. Ref performability — for actions targeting `@ref` selectors, every
 *      referenced element must still be present in the current snapshot (the
 *      driver resolves `@ref` by locating its `[ref=…]` token; a vanished ref
 *      can't be clicked/typed). Selectors the guard cannot statically resolve
 *      (CSS, text=, role=) proceed and defer to execution + effect verification.
 */

import type { Action } from '../../types/actions.js';
import { findElementForRef } from '../utils.js';
import type { ReplayGuard, ReplayObservation, ReplayStep, StepGuardResult } from './contracts.js';

const PROCEED: StepGuardResult = { decision: 'proceed' };

function normalizeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    // Opaque origins (about:blank, data:, blob:) serialize to the string
    // "null". Treat them as unresolvable so the gate defers rather than
    // healing on a spurious "null" vs real-origin mismatch.
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect every `@ref`-style selector an action targets. Actions whose targets
 * are coordinates, labels, CSS/text selectors, or URLs contribute nothing —
 * those are deferred to execution rather than statically gated.
 */
function collectRefSelectors(action: Action): string[] {
  switch (action.action) {
    case 'click':
    case 'type':
    case 'press':
    case 'hover':
    case 'select':
      return [action.selector];
    case 'scroll':
      return action.selector ? [action.selector] : [];
    case 'fill': {
      const refs: string[] = [];
      if (action.fields) refs.push(...Object.keys(action.fields));
      if (action.selects) refs.push(...Object.keys(action.selects));
      if (action.checks) refs.push(...action.checks);
      return refs;
    }
    case 'clickSequence':
      return action.refs;
    default:
      return [];
  }
}

/** Default {@link ReplayGuard}: origin consistency + `@ref` performability. */
export class RefPerformabilityGuard implements ReplayGuard {
  check(step: ReplayStep, current: ReplayObservation): StepGuardResult {
    // 1. Origin consistency. Only gate when BOTH origins resolve — an
    //    unparseable recorded/current URL (about:blank, data:) is not evidence
    //    of drift, so we defer rather than heal.
    const recordedOrigin = normalizeOrigin(step.url);
    const liveOrigin = normalizeOrigin(current.url);
    if (recordedOrigin && liveOrigin && recordedOrigin !== liveOrigin) {
      return {
        decision: 'abort',
        reason: `origin drift: step recorded on ${recordedOrigin} but live page is on ${liveOrigin}`,
      };
    }

    // 2. Ref performability. Every `@ref` the action targets must still be
    //    present (and named) in the live snapshot.
    const refSelectors = collectRefSelectors(step.action).filter((s) => s.startsWith('@'));
    for (const selector of refSelectors) {
      if (findElementForRef(current.snapshot, selector) === undefined) {
        return {
          decision: 'abort',
          reason: `target ${selector} for ${step.action.action} is no longer present in the live snapshot`,
        };
      }
    }

    return PROCEED;
  }
}

/** Convenience factory mirroring the controller's `createReplayController`. */
export function createReplayGuard(): ReplayGuard {
  return new RefPerformabilityGuard();
}
