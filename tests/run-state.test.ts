import { describe, expect, it } from 'vitest';
import { RunState } from '../src/run-state.js';

describe('RunState', () => {
  it('computes maxTotalErrors as ceil(maxTurns/3) with minimum 3', () => {
    expect(new RunState(3).maxTotalErrors).toBe(3);
    expect(new RunState(6).maxTotalErrors).toBe(3);
    expect(new RunState(9).maxTotalErrors).toBe(3);
    expect(new RunState(10).maxTotalErrors).toBe(4);
    expect(new RunState(20).maxTotalErrors).toBe(7);
    expect(new RunState(1).maxTotalErrors).toBe(3);
  });

  it('initializes with zero errors', () => {
    const state = new RunState(20);
    expect(state.consecutiveErrors).toBe(0);
    expect(state.totalErrors).toBe(0);
    expect(state.isErrorBudgetExhausted).toBe(false);
    expect(state.hasConsecutiveErrorThreshold).toBe(false);
  });

  it('recordError increments both consecutive and total', () => {
    const state = new RunState(20);
    state.recordError();
    expect(state.consecutiveErrors).toBe(1);
    expect(state.totalErrors).toBe(1);
    state.recordError();
    expect(state.consecutiveErrors).toBe(2);
    expect(state.totalErrors).toBe(2);
  });

  it('clearConsecutiveErrors resets only consecutive count', () => {
    const state = new RunState(20);
    state.recordError();
    state.recordError();
    state.clearConsecutiveErrors();
    expect(state.consecutiveErrors).toBe(0);
    expect(state.totalErrors).toBe(2);
  });

  it('hasConsecutiveErrorThreshold triggers at 3', () => {
    const state = new RunState(20);
    state.recordError();
    state.recordError();
    expect(state.hasConsecutiveErrorThreshold).toBe(false);
    state.recordError();
    expect(state.hasConsecutiveErrorThreshold).toBe(true);
  });

  it('isErrorBudgetExhausted triggers at maxTotalErrors', () => {
    const state = new RunState(9); // maxTotalErrors = 3
    state.recordError();
    state.recordError();
    expect(state.isErrorBudgetExhausted).toBe(false);
    state.recordError();
    expect(state.isErrorBudgetExhausted).toBe(true);
  });

  it('clearConsecutiveErrors does not affect error budget', () => {
    const state = new RunState(9); // maxTotalErrors = 3
    state.recordError();
    state.recordError();
    state.clearConsecutiveErrors();
    state.recordError(); // totalErrors now 3
    expect(state.isErrorBudgetExhausted).toBe(true);
    expect(state.hasConsecutiveErrorThreshold).toBe(false); // only 1 consecutive
  });

  it('initializes optional state fields correctly', () => {
    const state = new RunState(20);
    expect(state.verificationRejectionCount).toBe(0);
    expect(state.firstSufficientEvidenceTurn).toBeUndefined();
    expect(state.supervisorInterventions).toBe(0);
    expect(state.lastSupervisorTurn).toBe(-Infinity);
    expect(state.goalVerificationEvidence).toEqual([]);
    expect(state.searchScoutUrls.size).toBe(0);
  });

  it('goalVerificationEvidence and searchScoutUrls are mutable', () => {
    const state = new RunState(20);
    state.goalVerificationEvidence.push('evidence 1');
    state.searchScoutUrls.add('https://example.com');
    expect(state.goalVerificationEvidence).toEqual(['evidence 1']);
    expect(state.searchScoutUrls.has('https://example.com')).toBe(true);
  });
});
