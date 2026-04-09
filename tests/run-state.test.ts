import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKEN_BUDGET, RunState } from '../src/run-state.js';

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

  describe('Gen 10 cost cap', () => {
    it('defaults to DEFAULT_TOKEN_BUDGET', () => {
      const state = new RunState(20);
      expect(state.tokenBudget).toBe(DEFAULT_TOKEN_BUDGET);
      expect(state.totalTokensUsed).toBe(0);
      expect(state.isTokenBudgetExhausted).toBe(false);
    });

    it('accepts an explicit budget override', () => {
      const state = new RunState(20, 1000);
      expect(state.tokenBudget).toBe(1000);
    });

    it('honors BAD_TOKEN_BUDGET env var', () => {
      const original = process.env.BAD_TOKEN_BUDGET;
      try {
        process.env.BAD_TOKEN_BUDGET = '12345';
        const state = new RunState(20);
        expect(state.tokenBudget).toBe(12345);
      } finally {
        if (original === undefined) delete process.env.BAD_TOKEN_BUDGET;
        else process.env.BAD_TOKEN_BUDGET = original;
      }
    });

    it('explicit budget arg wins over env var', () => {
      const original = process.env.BAD_TOKEN_BUDGET;
      try {
        process.env.BAD_TOKEN_BUDGET = '12345';
        const state = new RunState(20, 5000);
        expect(state.tokenBudget).toBe(5000);
      } finally {
        if (original === undefined) delete process.env.BAD_TOKEN_BUDGET;
        else process.env.BAD_TOKEN_BUDGET = original;
      }
    });

    it('recordTokens accumulates', () => {
      const state = new RunState(20, 1000);
      state.recordTokens(100);
      state.recordTokens(250);
      expect(state.totalTokensUsed).toBe(350);
      expect(state.isTokenBudgetExhausted).toBe(false);
    });

    it('recordTokens ignores undefined / zero / negative', () => {
      const state = new RunState(20, 1000);
      state.recordTokens(undefined);
      state.recordTokens(0);
      state.recordTokens(-50);
      state.recordTokens(NaN);
      state.recordTokens(Infinity);
      expect(state.totalTokensUsed).toBe(0);
    });

    it('isTokenBudgetExhausted fires at exactly the budget', () => {
      const state = new RunState(20, 1000);
      state.recordTokens(999);
      expect(state.isTokenBudgetExhausted).toBe(false);
      state.recordTokens(1);
      expect(state.isTokenBudgetExhausted).toBe(true);
    });

    it('isTokenBudgetExhausted stays true after overage', () => {
      const state = new RunState(20, 1000);
      state.recordTokens(2500);
      expect(state.isTokenBudgetExhausted).toBe(true);
      expect(state.totalTokensUsed).toBe(2500);
    });
  });
});
