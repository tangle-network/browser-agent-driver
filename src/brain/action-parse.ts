/**
 * Action parsing + runtime validation for LLM-emitted action JSON.
 *
 * Pure functions, no shared state — `parseNextActions` takes the valid-action
 * set as a parameter so it stays decoupled from the Brain class.
 */

import type { Action } from '../types.js';

function parseNextActions(parsed: Record<string, unknown>, validActions: Set<string>): Action[] | undefined {
  if (!Array.isArray(parsed.nextActions)) {
    return undefined;
  }

  const nextActions: Action[] = [];
  for (const entry of parsed.nextActions.slice(0, 3)) {
    if (!entry || typeof entry !== 'object') continue;
    const rawEntry = entry as Record<string, unknown>;
    const actionType = typeof rawEntry.action === 'string' ? rawEntry.action : undefined;
    if (!actionType || !validActions.has(actionType)) continue;
    try {
      nextActions.push(validateAction(actionType, rawEntry));
    } catch {
      // Best effort: ignore malformed follow-up action.
    }
  }

  return nextActions.length > 0 ? nextActions : undefined;
}

/**
 * Runtime validation of LLM-parsed action objects.
 * Ensures required fields are present and correctly typed per action variant.
 * Throws on missing/invalid fields so the caller can abort gracefully.
 */
function validateAction(actionType: string, data: Record<string, unknown>): Action {
  const requireStr = (field: string): string => {
    const v = data[field];
    if (typeof v !== 'string' || !v) throw new Error(`${actionType} action requires "${field}" (string)`);
    return v;
  };
  const optStr = (field: string): string => {
    const v = data[field];
    return typeof v === 'string' ? v : '';
  };
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

  switch (actionType) {
    case 'click':
      return { action: 'click', selector: requireStr('selector') };
    case 'type':
      return { action: 'type', selector: requireStr('selector'), text: optStr('text') };
    case 'press':
      return { action: 'press', selector: requireStr('selector'), key: requireStr('key') };
    case 'hover':
      return { action: 'hover', selector: requireStr('selector') };
    case 'select':
      return { action: 'select', selector: requireStr('selector'), value: optStr('value') };
    case 'scroll':
      return {
        action: 'scroll',
        direction: data.direction === 'up' ? 'up' : 'down',
        ...(data.amount != null ? { amount: num(data.amount, 500) } : {}),
      };
    case 'navigate':
      return { action: 'navigate', url: requireStr('url') };
    case 'wait':
      return { action: 'wait', ms: num(data.ms, 1000) };
    case 'evaluate':
      return { action: 'evaluate', criteria: optStr('criteria') };
    case 'runScript':
      return { action: 'runScript', script: requireStr('script') };
    case 'extractWithIndex': {
      const query = requireStr('query');
      const contains = typeof data.contains === 'string' ? data.contains : '';
      return {
        action: 'extractWithIndex',
        query,
        ...(contains ? { contains } : {}),
      };
    }
    case 'verifyPreview':
      return { action: 'verifyPreview' };
    case 'complete':
      return { action: 'complete', result: optStr('result') };
    case 'abort':
      return { action: 'abort', reason: optStr('reason') || 'No reason provided' };
    case 'fill': {
      // Multi-field batch fill — at least one of fields/selects/checks must be non-empty
      const fields = isStringRecord(data.fields) ? data.fields : undefined;
      const selects = isStringRecord(data.selects) ? data.selects : undefined;
      const checks = Array.isArray(data.checks) && data.checks.every((c) => typeof c === 'string')
        ? (data.checks as string[])
        : undefined;
      const fieldCount = (fields ? Object.keys(fields).length : 0)
        + (selects ? Object.keys(selects).length : 0)
        + (checks ? checks.length : 0);
      if (fieldCount === 0) {
        throw new Error('fill action requires at least one of "fields" (object), "selects" (object), or "checks" (string[])');
      }
      return {
        action: 'fill',
        ...(fields ? { fields } : {}),
        ...(selects ? { selects } : {}),
        ...(checks ? { checks } : {}),
      };
    }
    case 'clickSequence': {
      const refs = Array.isArray(data.refs) && data.refs.every((r) => typeof r === 'string')
        ? (data.refs as string[])
        : null;
      if (!refs || refs.length === 0) {
        throw new Error('clickSequence action requires "refs" (string[]) with at least one entry');
      }
      return {
        action: 'clickSequence',
        refs,
        ...(typeof data.intervalMs === 'number' ? { intervalMs: data.intervalMs } : {}),
      };
    }
    // Vision-first coordinate actions.
    case 'clickAt':
      return { action: 'clickAt', x: num(data.x, 0), y: num(data.y, 0) };
    case 'typeAt':
      return { action: 'typeAt', x: num(data.x, 0), y: num(data.y, 0), text: optStr('text') };
    // Set-of-Marks label-based actions.
    case 'clickLabel':
      return { action: 'clickLabel', label: num(data.label, 0) };
    case 'typeLabel':
      return { action: 'typeLabel', label: num(data.label, 0), text: optStr('text') };
    // Macro invocation. The driver validates the name and required args at
    // execute time; macros without params may omit args.
    case 'macro': {
      const args: Record<string, string> = {};
      if (data.args && typeof data.args === 'object' && !Array.isArray(data.args)) {
        for (const [k, v] of Object.entries(data.args as Record<string, unknown>)) {
          if (typeof v === 'string') args[k] = v;
        }
      }
      return {
        action: 'macro',
        name: requireStr('name'),
        ...(Object.keys(args).length > 0 ? { args } : {}),
      };
    }
    case 'fanOut': {
      // Accept either explicit subGoals[] or the shorthand
      // baseUrl+goalTemplate+items trio. resolveSubGoals() in
      // runner/fan-out.ts expands shorthand → subGoals at execute time.
      const subGoals = Array.isArray(data.subGoals)
        ? (data.subGoals as Array<Record<string, unknown>>)
            .filter((s) => s && typeof s === 'object')
            .map((s) => ({
              url: typeof s.url === 'string' ? s.url : '',
              goal: typeof s.goal === 'string' ? s.goal : '',
              ...(typeof s.label === 'string' ? { label: s.label } : {}),
              ...(typeof s.maxTurns === 'number' ? { maxTurns: s.maxTurns } : {}),
            }))
            .filter((s) => s.url && s.goal)
        : undefined;
      const baseUrl = typeof data.baseUrl === 'string' ? data.baseUrl : undefined;
      const goalTemplate = typeof data.goalTemplate === 'string' ? data.goalTemplate : undefined;
      const items = Array.isArray(data.items) && data.items.every((i) => typeof i === 'string')
        ? (data.items as string[])
        : undefined;
      const hasExplicit = subGoals && subGoals.length > 0;
      const hasShorthand = baseUrl && goalTemplate && items && items.length > 0;
      if (!hasExplicit && !hasShorthand) {
        throw new Error('fanOut action requires either "subGoals" (array of {url,goal}) or the shorthand trio "baseUrl" + "goalTemplate" + "items" (non-empty string[])');
      }
      return {
        action: 'fanOut',
        ...(hasExplicit ? { subGoals } : {}),
        ...(hasShorthand ? { baseUrl, goalTemplate, items } : {}),
        ...(typeof data.summarize === 'string' ? { summarize: data.summarize } : {}),
      };
    }
    default:
      throw new Error(`Unknown action type: ${actionType}`);
  }
}

/** Type guard: value is a Record<string, string> */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

export { parseNextActions, validateAction };
