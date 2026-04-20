import { snapshotHash } from '../recovery.js';
import type { Action, PageState, SupervisorSignal, Turn } from '../types.js';

export interface SupervisorPolicyInput {
  recentTurns: Turn[];
  currentState: PageState;
  currentTurn: number;
  maxTurns: number;
  window?: number;
}

const DEFAULT_WINDOW = 4;

export function detectSupervisorSignal(input: SupervisorPolicyInput): SupervisorSignal {
  const window = Math.max(3, input.window ?? DEFAULT_WINDOW);
  const recent = input.recentTurns.slice(-window);
  if (recent.length < 2) {
    return {
      severity: 'none',
      reasons: [],
      repeatedActionCount: 0,
      unchangedTurns: 0,
      errorTurns: 0,
      verificationFailures: 0,
    };
  }

  const fingerprints = [
    ...recent.map((turn) => pageFingerprint(turn.state)),
    pageFingerprint(input.currentState),
  ];
  const unchangedTurns = trailingSameCount(fingerprints);

  const actionSignatures = recent
    .map((turn) => actionSignature(turn.action))
    .filter((signature) => signature !== 'wait');
  const repeatedActionCount = trailingSameCount(actionSignatures);

  const errorTurns = recent.filter((turn) => Boolean(turn.error)).length;
  const verificationFailures = recent.filter((turn) => Boolean(turn.verificationFailure)).length;
  const remainingTurns = Math.max(0, input.maxTurns - input.currentTurn);

  const hardReasons: string[] = [];
  if (unchangedTurns >= 4 && repeatedActionCount >= 3) {
    hardReasons.push('same-page repeated action loop');
  }
  if (errorTurns >= 3) {
    hardReasons.push('error burst');
  }
  if (unchangedTurns >= 4 && verificationFailures >= 2) {
    hardReasons.push('verification deadlock');
  }
  if (remainingTurns <= 3 && (unchangedTurns >= 3 || errorTurns >= 2)) {
    hardReasons.push('endgame stall with low turn budget');
  }

  const softReasons: string[] = [];
  if (unchangedTurns >= 3) softReasons.push('page unchanged');
  if (repeatedActionCount >= 2) softReasons.push('action repetition');
  if (errorTurns >= 2) softReasons.push('repeat execution errors');
  if (verificationFailures >= 1) softReasons.push('verification mismatch');

  const reasons = hardReasons.length > 0 ? hardReasons : softReasons;
  const severity: SupervisorSignal['severity'] = hardReasons.length > 0 ? 'hard' : (softReasons.length > 0 ? 'soft' : 'none');

  return {
    severity,
    reasons,
    repeatedActionCount,
    unchangedTurns,
    errorTurns,
    verificationFailures,
  };
}

export function formatSupervisorSignal(signal: SupervisorSignal): string {
  if (signal.severity === 'none') return 'no stall signal';
  return [
    `severity=${signal.severity}`,
    `reasons=${signal.reasons.join(', ')}`,
    `unchanged=${signal.unchangedTurns}`,
    `repeatedActions=${signal.repeatedActionCount}`,
    `errors=${signal.errorTurns}`,
    `verificationFailures=${signal.verificationFailures}`,
  ].join(' | ');
}

function pageFingerprint(state: PageState): string {
  return `${state.url}#${snapshotHash(state.snapshot)}`;
}

function trailingSameCount(values: string[]): number {
  if (values.length === 0) return 0;
  const last = values[values.length - 1];
  let count = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== last) break;
    count++;
  }
  return count;
}

function actionSignature(action: Action): string {
  switch (action.action) {
    case 'click':
      return `click:${action.selector}`;
    case 'type':
      return `type:${action.selector}:${action.text.slice(0, 64)}`;
    case 'press':
      return `press:${action.selector}:${action.key}`;
    case 'hover':
      return `hover:${action.selector}`;
    case 'select':
      return `select:${action.selector}:${action.value}`;
    case 'scroll':
      return `scroll:${action.direction}:${action.amount ?? 500}:${action.selector ?? 'viewport'}`;
    case 'navigate':
      return `navigate:${action.url}`;
    case 'wait':
      return 'wait';
    case 'evaluate':
      return `evaluate:${action.criteria}`;
    case 'runScript':
      return `runScript:${action.script.slice(0, 64)}`;
    case 'extractWithIndex':
      return `extractWithIndex:${action.query.slice(0, 64)}:${action.contains ?? ''}`;
    case 'verifyPreview':
      return 'verifyPreview';
    case 'complete':
      return 'complete';
    case 'abort':
      return 'abort';
    case 'fill': {
      // Multi-field batch — signature includes the sorted ref list so two
      // fills with the same target set look identical to the stuck detector,
      // even if the values differ. The values themselves are not part of the
      // signature because the agent can fill different values into the same
      // fields without it being a "stuck" loop.
      const fieldRefs = Object.keys(action.fields ?? {}).sort().join(',');
      const selectRefs = Object.keys(action.selects ?? {}).sort().join(',');
      const checkRefs = (action.checks ?? []).slice().sort().join(',');
      return `fill:${fieldRefs}|${selectRefs}|${checkRefs}`;
    }
    case 'clickSequence':
      return `clickSequence:${action.refs.join(',')}`;
    case 'clickAt':
      return `clickAt:${action.x},${action.y}`;
    case 'typeAt':
      return `typeAt:${action.x},${action.y}:${action.text.slice(0, 32)}`;
    case 'clickLabel':
      return `clickLabel:${action.label}`;
    case 'typeLabel':
      return `typeLabel:${action.label}:${action.text.slice(0, 32)}`;
    case 'macro': {
      const argSig = Object.entries(action.args ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v.slice(0, 32)}`)
        .join('|');
      return `macro:${action.name}:${argSig}`;
    }
  }
}
