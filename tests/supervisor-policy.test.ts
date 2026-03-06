import { describe, expect, it } from 'vitest';
import { detectSupervisorSignal, formatSupervisorSignal } from '../src/supervisor/policy.js';
import type { Action, Turn } from '../src/types.js';

function makeTurn(turn: number, action: Action, opts?: { url?: string; snapshot?: string; error?: string; verificationFailure?: string }): Turn {
  return {
    turn,
    state: {
      url: opts?.url ?? 'https://app.example.com/workspace',
      title: 'App',
      snapshot: opts?.snapshot ?? '- heading "Workspace" [level=1]',
    },
    action,
    durationMs: 120,
    ...(opts?.error ? { error: opts.error } : {}),
    ...(opts?.verificationFailure ? { verificationFailure: opts.verificationFailure } : {}),
  };
}

describe('detectSupervisorSignal', () => {
  it('returns none when there is not enough history', () => {
    const signal = detectSupervisorSignal({
      recentTurns: [makeTurn(1, { action: 'click', selector: '@a1' })],
      currentState: {
        url: 'https://app.example.com/workspace',
        title: 'App',
        snapshot: '- heading "Workspace" [level=1]',
      },
      currentTurn: 2,
      maxTurns: 20,
    });

    expect(signal.severity).toBe('none');
  });

  it('emits soft signal for repeated action with unchanged page', () => {
    const snapshot = '- button "Run" [ref=b1]';
    const turns = [
      makeTurn(1, { action: 'click', selector: '@b1' }, { snapshot }),
      makeTurn(2, { action: 'wait', ms: 400 }, { snapshot }),
      makeTurn(3, { action: 'click', selector: '@b1' }, { snapshot }),
    ];

    const signal = detectSupervisorSignal({
      recentTurns: turns,
      currentState: turns[2].state,
      currentTurn: 4,
      maxTurns: 20,
      window: 3,
    });

    expect(signal.severity).toBe('soft');
    expect(signal.reasons).toContain('page unchanged');
    expect(signal.reasons).not.toContain('same-page repeated action loop');
  });

  it('emits hard signal for repeated action loop on same page', () => {
    const snapshot = '- button "Submit" [ref=b2]';
    const turns = [
      makeTurn(1, { action: 'click', selector: '@b2' }, { snapshot }),
      makeTurn(2, { action: 'click', selector: '@b2' }, { snapshot }),
      makeTurn(3, { action: 'click', selector: '@b2' }, { snapshot }),
      makeTurn(4, { action: 'click', selector: '@b2' }, { snapshot }),
    ];

    const signal = detectSupervisorSignal({
      recentTurns: turns,
      currentState: turns[3].state,
      currentTurn: 5,
      maxTurns: 20,
      window: 4,
    });

    expect(signal.severity).toBe('hard');
    expect(signal.reasons).toContain('same-page repeated action loop');
    expect(formatSupervisorSignal(signal)).toContain('severity=hard');
  });

  it('emits hard signal for error burst', () => {
    const turns = [
      makeTurn(1, { action: 'click', selector: '@x1' }, { error: 'selector missing' }),
      makeTurn(2, { action: 'click', selector: '@x1' }, { error: 'selector missing' }),
      makeTurn(3, { action: 'click', selector: '@x1' }, { error: 'selector missing' }),
      makeTurn(4, { action: 'wait', ms: 500 }),
    ];

    const signal = detectSupervisorSignal({
      recentTurns: turns,
      currentState: turns[3].state,
      currentTurn: 5,
      maxTurns: 20,
      window: 4,
    });

    expect(signal.severity).toBe('hard');
    expect(signal.reasons).toContain('error burst');
  });

  it('escalates to hard near max turn budget', () => {
    const snapshot = '- heading "Project limit reached" [level=1]';
    const turns = [
      makeTurn(8, { action: 'click', selector: '@b1' }, { snapshot }),
      makeTurn(9, { action: 'click', selector: '@b1' }, { snapshot }),
      makeTurn(10, { action: 'click', selector: '@b1' }, { snapshot }),
    ];

    const signal = detectSupervisorSignal({
      recentTurns: turns,
      currentState: turns[2].state,
      currentTurn: 11,
      maxTurns: 12,
      window: 3,
    });

    expect(signal.severity).toBe('hard');
    expect(signal.reasons).toContain('endgame stall with low turn budget');
  });
});
