import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('returns partial page state when observe exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    const slowDriver: Driver = {
      observe: vi.fn(async () => new Promise<never>(() => {})),
      execute: vi.fn(async () => ({ success: true })),
      getUrl: () => 'https://example.com/slow',
      getPage: () => ({
        url: () => 'https://example.com/slow',
        title: async () => 'Slow Page',
      }) as any,
      close: vi.fn(async () => {}),
    };
    const runner = new BrowserAgent({
      driver: slowDriver,
      config: { observeTimeoutMs: 25 },
    });

    const promise = (runner as any).observeWithTimeout();
    await vi.advanceTimersByTimeAsync(25);
    const state = await promise;

    expect(state).toMatchObject({
      url: 'https://example.com/slow',
      title: 'Slow Page',
    });
    expect(state.snapshot).toContain('observe degraded: timeout after 25ms');
  });
});
