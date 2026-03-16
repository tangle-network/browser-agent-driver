import { describe, expect, it } from 'vitest';
import { BrowserAgent } from '../src/runner.js';
import type { Action } from '../src/types.js';
import type { Driver } from '../src/drivers/types.js';

const noopDriver: Driver = {
  async observe() {
    return { url: 'https://example.com', title: 'Example', snapshot: '' };
  },
  async execute() {
    return { success: true };
  },
  async close() {
    return;
  },
};

describe('BrowserAgent micro-plan selection', () => {
  it('filters follow-up actions to safe set and respects maxActionsPerTurn', () => {
    const runner = new BrowserAgent({
      driver: noopDriver,
      config: { microPlan: { enabled: true, maxActionsPerTurn: 3 } },
    });

    const selected = (runner as unknown as {
      selectFollowUpActions: (primary: Action, next?: Action[]) => Action[];
    }).selectFollowUpActions(
      { action: 'click', selector: '@b1' },
      [
        { action: 'type', selector: '@i1', text: 'hello' },
        { action: 'navigate', url: 'https://example.com/next' },
        { action: 'press', selector: '@i1', key: 'Enter' },
      ],
    );

    expect(selected).toEqual([
      { action: 'type', selector: '@i1', text: 'hello' },
      { action: 'press', selector: '@i1', key: 'Enter' },
    ]);
  });

  it('returns no follow-up actions when micro-plan is disabled', () => {
    const runner = new BrowserAgent({
      driver: noopDriver,
      config: { microPlan: { enabled: false } },
    });

    const selected = (runner as unknown as {
      selectFollowUpActions: (primary: Action, next?: Action[]) => Action[];
    }).selectFollowUpActions(
      { action: 'click', selector: '@b1' },
      [{ action: 'wait', ms: 200 }],
    );

    expect(selected).toEqual([]);
  });
});

