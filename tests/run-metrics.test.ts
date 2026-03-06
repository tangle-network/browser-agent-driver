import { describe, expect, it } from 'vitest';
import { countRepeatedQueries, deriveWasteMetrics } from '../src/run-metrics.js';
import type { Turn } from '../src/types.js';

function makeTurn(turn: number, overrides: Partial<Turn>): Turn {
  return {
    turn,
    state: { url: 'https://example.com', title: 'Example', snapshot: '- textbox "@search"' },
    action: { action: 'wait', ms: 100 },
    durationMs: 100,
    ...overrides,
  };
}

describe('run-metrics', () => {
  it('counts repeated search queries only for search-like selectors', () => {
    const turns: Turn[] = [
      makeTurn(1, { action: { action: 'type', selector: 'input[name="q"]', text: 'alzheimer disease' } }),
      makeTurn(2, { action: { action: 'type', selector: 'input[name="q"]', text: 'alzheimer disease' } }),
      makeTurn(3, { action: { action: 'type', selector: '#email', text: 'alice@example.com' } }),
      makeTurn(4, { action: { action: 'type', selector: 'input[name="keywords"]', text: 'alzheimer disease' } }),
      makeTurn(5, { action: { action: 'type', selector: 'input[name="keywords"]', text: 'alzheimer disease' } }),
    ];

    expect(countRepeatedQueries(turns)).toBe(2);
  });

  it('derives waste metrics from turns and evidence markers', () => {
    const turns: Turn[] = [
      makeTurn(1, { action: { action: 'type', selector: 'input[name="q"]', text: 'yale about' } }),
      makeTurn(2, { action: { action: 'type', selector: 'input[name="q"]', text: 'yale about' } }),
      makeTurn(3, { action: { action: 'complete', result: 'Yale summary' } }),
      makeTurn(4, { action: { action: 'wait', ms: 0 }, error: 'timeout' }),
      makeTurn(5, { action: { action: 'complete', result: 'Yale summary' } }),
    ];

    expect(deriveWasteMetrics(turns, 1, 3)).toEqual({
      repeatedQueryCount: 1,
      verificationRejectionCount: 1,
      turnsAfterSufficientEvidence: 2,
      errorTurns: 1,
    });
  });
});
