import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM script lib, no types
import { buildDelta } from '../scripts/lib/ab-delta.mjs';

const arm = (over: Record<string, unknown>) => ({
  rawPassRate: { mean: 1 },
  cleanPassRate: { mean: 1 },
  avgDecideLlmCalls: 0,
  avgDecideSkips: 0,
  avgDecideMs: 0,
  ...over,
});

describe('buildDelta — decide-phase metrics aggregation', () => {
  it('reports decideLlmCalls / decideMs / decideSkips deltas (treatment − control)', () => {
    const byArm = {
      off: arm({ avgDecideLlmCalls: 6, avgDecideSkips: 1, avgDecideMs: 65_000 }),
      on: arm({ avgDecideLlmCalls: 2, avgDecideSkips: 1, avgDecideMs: 27_000 }),
    };
    const runs = [
      { arm: 'off', testOutcomes: [1], cleanOutcomes: [1] },
      { arm: 'on', testOutcomes: [1], cleanOutcomes: [1] },
    ];
    const d = buildDelta(['off', 'on'], byArm, runs);
    expect(d.control).toBe('off');
    expect(d.treatment).toBe('on');
    // replay removes decide calls → negative delta
    expect(d.decide.llmCallsOnMinusOff).toBe(-4);
    expect(d.decide.msOnMinusOff).toBe(-38_000);
    expect(d.decide.skipsOnMinusOff).toBe(0);
  });

  it('maps first/second arm to control/treatment when not named off/on', () => {
    const byArm = {
      baseline: arm({ avgDecideLlmCalls: 5 }),
      replay: arm({ avgDecideLlmCalls: 3 }),
    };
    const runs = [
      { arm: 'baseline', testOutcomes: [1], cleanOutcomes: [1] },
      { arm: 'replay', testOutcomes: [1], cleanOutcomes: [1] },
    ];
    const d = buildDelta(['baseline', 'replay'], byArm, runs);
    expect(d.treatment).toBe('replay');
    expect(d.decide.llmCallsOnMinusOff).toBe(-2);
  });

  it('returns null when the comparison is not exactly two arms', () => {
    expect(buildDelta(['a', 'b', 'c'], {}, [])).toBeNull();
  });
});
