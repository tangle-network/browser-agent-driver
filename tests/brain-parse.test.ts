import { describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/index.js';

describe('Brain.parse', () => {
  it('parses optional nextActions for micro-plans', () => {
    const brain = new Brain();
    const parsed = (brain as unknown as { parse: (raw: string) => unknown }).parse(
      JSON.stringify({
        plan: ['open composer', 'type prompt', 'submit'],
        currentStep: 1,
        action: { action: 'click', selector: '@b1' },
        nextActions: [
          { action: 'type', selector: '@i2', text: 'hello world' },
          { action: 'press', selector: '@i2', key: 'Enter' },
        ],
        reasoning: 'Deterministic composer flow',
        expectedEffect: 'Message should be submitted',
      }),
    ) as { action: { action: string }; nextActions?: Array<{ action: string }> };

    expect(parsed.action.action).toBe('click');
    expect(parsed.nextActions?.map((entry) => entry.action)).toEqual(['type', 'press']);
  });

  it('ignores malformed nextActions entries and keeps primary action', () => {
    const brain = new Brain();
    const parsed = (brain as unknown as { parse: (raw: string) => unknown }).parse(
      JSON.stringify({
        action: { action: 'click', selector: '@b1' },
        nextActions: [
          { action: 'unknown-action' },
          { nope: true },
          { action: 'wait', ms: 300 },
        ],
      }),
    ) as { action: { action: string }; nextActions?: Array<{ action: string }> };

    expect(parsed.action.action).toBe('click');
    expect(parsed.nextActions?.map((entry) => entry.action)).toEqual(['wait']);
  });
});

