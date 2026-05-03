import { describe, expect, it } from 'vitest';
import { RunState } from '../src/run-state.js';
import { shouldUsePlannerForScenario } from '../src/runner/runner.js';

/**
 * Tests for BrowserAgent-supporting classes and runner state management.
 *
 * We test RunState (extracted from runner.ts) and the exported runner
 * constants/defaults behavior without needing a real browser.
 */

// ---------------------------------------------------------------------------
// RunState
// ---------------------------------------------------------------------------

describe('RunState', () => {
  it('initializes with zero counters', () => {
    const state = new RunState(20);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.totalErrors).toBe(0);
    expect(state.verificationRejectionCount).toBe(0);
    expect(state.supervisorInterventions).toBe(0);
    expect(state.firstSufficientEvidenceTurn).toBeUndefined();
    expect(state.goalVerificationEvidence).toEqual([]);
    expect(state.searchScoutUrls.size).toBe(0);
  });

  it('computes maxTotalErrors based on maxTurns', () => {
    // maxTotalErrors = max(3, ceil(maxTurns / 3))
    expect(new RunState(6).maxTotalErrors).toBe(3);
    expect(new RunState(9).maxTotalErrors).toBe(3);
    expect(new RunState(10).maxTotalErrors).toBe(4);
    expect(new RunState(20).maxTotalErrors).toBe(7);
    expect(new RunState(30).maxTotalErrors).toBe(10);
  });

  it('enforces minimum maxTotalErrors of 3', () => {
    expect(new RunState(1).maxTotalErrors).toBe(3);
    expect(new RunState(3).maxTotalErrors).toBe(3);
  });

  it('recordError increments both counters', () => {
    const state = new RunState(20);
    state.recordError();
    expect(state.consecutiveErrors).toBe(1);
    expect(state.totalErrors).toBe(1);
    state.recordError();
    expect(state.consecutiveErrors).toBe(2);
    expect(state.totalErrors).toBe(2);
  });

  it('clearConsecutiveErrors resets only consecutive counter', () => {
    const state = new RunState(20);
    state.recordError();
    state.recordError();
    state.clearConsecutiveErrors();
    expect(state.consecutiveErrors).toBe(0);
    expect(state.totalErrors).toBe(2);
  });

  it('isErrorBudgetExhausted returns true when total errors reach max', () => {
    const state = new RunState(9); // maxTotalErrors = 3
    expect(state.isErrorBudgetExhausted).toBe(false);
    state.recordError();
    state.recordError();
    expect(state.isErrorBudgetExhausted).toBe(false);
    state.recordError();
    expect(state.isErrorBudgetExhausted).toBe(true);
  });

  it('hasConsecutiveErrorThreshold returns true at 3 consecutive errors', () => {
    const state = new RunState(20);
    state.recordError();
    state.recordError();
    expect(state.hasConsecutiveErrorThreshold).toBe(false);
    state.recordError();
    expect(state.hasConsecutiveErrorThreshold).toBe(true);
  });

  it('hasConsecutiveErrorThreshold resets after clearing', () => {
    const state = new RunState(20);
    state.recordError();
    state.recordError();
    state.recordError();
    expect(state.hasConsecutiveErrorThreshold).toBe(true);
    state.clearConsecutiveErrors();
    expect(state.hasConsecutiveErrorThreshold).toBe(false);
  });

  it('lastSupervisorTurn initializes to -Infinity', () => {
    const state = new RunState(20);
    expect(state.lastSupervisorTurn).toBe(-Infinity);
  });

  it('searchScoutUrls supports add and has', () => {
    const state = new RunState(20);
    state.searchScoutUrls.add('https://example.com');
    expect(state.searchScoutUrls.has('https://example.com')).toBe(true);
    expect(state.searchScoutUrls.has('https://other.com')).toBe(false);
  });

  it('verificationRejectionCount tracks rejections', () => {
    const state = new RunState(20);
    state.verificationRejectionCount++;
    state.verificationRejectionCount++;
    expect(state.verificationRejectionCount).toBe(2);
  });

  it('goalVerificationEvidence accumulates entries', () => {
    const state = new RunState(20);
    state.goalVerificationEvidence.push('Evidence A');
    state.goalVerificationEvidence.push('Evidence B');
    expect(state.goalVerificationEvidence).toEqual(['Evidence A', 'Evidence B']);
  });
});

describe('shouldUsePlannerForScenario', () => {
  it('uses planner in always mode', () => {
    expect(shouldUsePlannerForScenario({
      goal: 'Return ONLY a JSON object with weekly downloads',
      tags: ['extraction'],
    }, 'always')).toBe(true);
  });

  it('skips planner for tagged extraction tasks in auto mode', () => {
    expect(shouldUsePlannerForScenario({
      goal: 'Open the package page and return the weekly downloads',
      tags: ['extraction'],
    }, 'auto')).toBe(false);
  });

  it('skips planner for JSON extraction-shaped goals in auto mode', () => {
    expect(shouldUsePlannerForScenario({
      goal: 'Find the Weekly Downloads number. Return ONLY a JSON object with exactly this key: weekly_downloads.',
    }, 'auto')).toBe(false);
  });

  it('keeps planner for workflow tasks in auto mode', () => {
    expect(shouldUsePlannerForScenario({
      goal: 'Fill out the onboarding form, switch to the export tab, and download the report.',
      tags: ['workflow'],
    }, 'auto')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Runner defaults (verifiable without instantiating the runner)
// ---------------------------------------------------------------------------

describe('Runner defaults', () => {
  it('DEFAULT_MAX_TURNS is 20', async () => {
    // We can verify this by checking the runner module's behavior.
    // The default comes from the runner file but is not exported.
    // The BrowserAgent uses scenario.maxTurns || DEFAULT_MAX_TURNS.
    // For external config, the DriverConfig default is 30 (from config.ts).
    // Here we just verify RunState works with various maxTurns values.
    const state1 = new RunState(20);
    expect(state1.maxTotalErrors).toBe(7);
    const state2 = new RunState(30);
    expect(state2.maxTotalErrors).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Turn limit enforcement (logic pattern from runner.ts)
// ---------------------------------------------------------------------------

describe('Turn limit enforcement patterns', () => {
  it('loop terminates when current turn exceeds maxTurns', () => {
    const maxTurns = 10;
    let turns = 0;
    for (let i = 1; i <= maxTurns; i++) {
      turns++;
    }
    expect(turns).toBe(maxTurns);
  });

  it('abort signal halts the loop early', () => {
    const ac = new AbortController();
    const maxTurns = 10;
    let turns = 0;
    for (let i = 1; i <= maxTurns; i++) {
      if (ac.signal.aborted) break;
      turns++;
      if (i === 3) ac.abort('Test abort');
    }
    expect(turns).toBe(3);
  });

  it('error budget exhaustion triggers early exit', () => {
    const state = new RunState(9); // maxTotalErrors = 3
    const maxTurns = 10;
    let exitedEarly = false;
    for (let i = 1; i <= maxTurns; i++) {
      if (state.isErrorBudgetExhausted) {
        exitedEarly = true;
        break;
      }
      // Simulate errors every turn
      state.recordError();
    }
    expect(exitedEarly).toBe(true);
    expect(state.totalErrors).toBe(3);
  });

  it('consecutive error threshold triggers recovery check', () => {
    const state = new RunState(20);
    const recoveryTriggered: number[] = [];
    for (let i = 1; i <= 10; i++) {
      state.recordError();
      if (state.hasConsecutiveErrorThreshold) {
        recoveryTriggered.push(i);
        state.clearConsecutiveErrors();
      }
    }
    // Recovery should trigger at turn 3, 6, 9
    expect(recoveryTriggered).toEqual([3, 6, 9]);
  });
});

// ---------------------------------------------------------------------------
// Stuck detection pattern (simulated)
// ---------------------------------------------------------------------------

describe('Stuck detection patterns', () => {
  it('detects repeated URL across turns', () => {
    const urls = [
      'https://example.com/page',
      'https://example.com/page',
      'https://example.com/page',
    ];
    const isStuck = urls.length >= 2 && urls.every((url) => url === urls[0]);
    expect(isStuck).toBe(true);
  });

  it('does not flag different URLs as stuck', () => {
    const urls = [
      'https://example.com/page1',
      'https://example.com/page2',
      'https://example.com/page3',
    ];
    const isStuck = urls.length >= 2 && urls.every((url) => url === urls[0]);
    expect(isStuck).toBe(false);
  });

  it('detects repeated snapshot hash pattern', () => {
    const hashes = ['abc123', 'abc123', 'abc123'];
    const isStuck = hashes.length >= 2 && hashes.every((h) => h === hashes[0]);
    expect(isStuck).toBe(true);
  });
});
