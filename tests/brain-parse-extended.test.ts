import { describe, expect, it } from 'vitest';
import { Brain } from '../src/brain/index.js';

/**
 * Extended tests for Brain.parse — covers various LLM response formats,
 * malformed responses, edge cases, and action validation.
 */

// Access private parse method for testing
function parseBrain(raw: string) {
  const brain = new Brain();
  return (brain as unknown as { parse: (raw: string) => unknown }).parse(raw);
}

type ParseResult = {
  action: { action: string; [key: string]: unknown };
  nextActions?: Array<{ action: string; [key: string]: unknown }>;
  reasoning?: string;
  plan?: string[];
  currentStep?: number;
  expectedEffect?: string;
};

describe('Brain.parse — action types', () => {
  it('parses a click action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      reasoning: 'Click the button',
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'click', selector: '@b1' });
  });

  it('parses a type action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'type', selector: '@t1', text: 'hello' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'type', selector: '@t1', text: 'hello' });
  });

  it('parses a press action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'press', selector: '@t1', key: 'Enter' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'press', selector: '@t1', key: 'Enter' });
  });

  it('parses a hover action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'hover', selector: '@m1' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'hover', selector: '@m1' });
  });

  it('parses a select action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'select', selector: '@s1', value: 'opt-2' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'select', selector: '@s1', value: 'opt-2' });
  });

  it('parses a scroll action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'scroll', direction: 'down', amount: 500 },
    })) as ParseResult;
    expect(result.action.action).toBe('scroll');
    expect(result.action.direction).toBe('down');
  });

  it('parses a scroll action defaulting direction to down', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'scroll', direction: 'invalid' },
    })) as ParseResult;
    expect(result.action.direction).toBe('down');
  });

  it('parses a navigate action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'navigate', url: 'https://example.com' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'navigate', url: 'https://example.com' });
  });

  it('parses a wait action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'wait', ms: 2000 },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'wait', ms: 2000 });
  });

  it('parses a wait action with default ms', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'wait' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'wait', ms: 1000 });
  });

  it('parses a complete action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'complete', result: 'Task done' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'complete', result: 'Task done' });
  });

  it('parses an abort action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'abort', reason: 'Blocked by captcha' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'abort', reason: 'Blocked by captcha' });
  });

  it('parses an abort action with default reason', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'abort' },
    })) as ParseResult;
    expect(result.action.reason).toBe('No reason provided');
  });

  it('parses an evaluate action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'evaluate', criteria: 'Is the layout clean?' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'evaluate', criteria: 'Is the layout clean?' });
  });

  it('parses a runScript action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'runScript', script: 'document.title' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'runScript', script: 'document.title' });
  });

  it('parses a verifyPreview action', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'verifyPreview' },
    })) as ParseResult;
    expect(result.action).toEqual({ action: 'verifyPreview' });
  });
});

describe('Brain.parse — metadata extraction', () => {
  it('extracts reasoning', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      reasoning: 'This button leads to the form',
    })) as ParseResult;
    expect(result.reasoning).toBe('This button leads to the form');
  });

  it('extracts reasoning from "thought" field', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      thought: 'Using thought field instead',
    })) as ParseResult;
    expect(result.reasoning).toBe('Using thought field instead');
  });

  it('extracts reasoning from "thinking" field', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      thinking: 'Using thinking field',
    })) as ParseResult;
    expect(result.reasoning).toBe('Using thinking field');
  });

  it('extracts plan array', () => {
    const result = parseBrain(JSON.stringify({
      plan: ['Step 1', 'Step 2', 'Step 3'],
      action: { action: 'click', selector: '@b1' },
    })) as ParseResult;
    expect(result.plan).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('ignores non-array plan field', () => {
    const result = parseBrain(JSON.stringify({
      plan: 'not an array',
      action: { action: 'click', selector: '@b1' },
    })) as ParseResult;
    expect(result.plan).toBeUndefined();
  });

  it('extracts currentStep', () => {
    const result = parseBrain(JSON.stringify({
      currentStep: 2,
      action: { action: 'click', selector: '@b1' },
    })) as ParseResult;
    expect(result.currentStep).toBe(2);
  });

  it('ignores non-numeric currentStep', () => {
    const result = parseBrain(JSON.stringify({
      currentStep: 'two',
      action: { action: 'click', selector: '@b1' },
    })) as ParseResult;
    expect(result.currentStep).toBeUndefined();
  });

  it('extracts expectedEffect', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      expectedEffect: 'Modal should open',
    })) as ParseResult;
    expect(result.expectedEffect).toBe('Modal should open');
  });

  it('extracts expected_effect (snake_case variant)', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      expected_effect: 'Page should navigate',
    })) as ParseResult;
    expect(result.expectedEffect).toBe('Page should navigate');
  });
});

describe('Brain.parse — format tolerance', () => {
  it('strips markdown code blocks', () => {
    const raw = '```json\n{"action": {"action": "click", "selector": "@b1"}}\n```';
    const result = parseBrain(raw) as ParseResult;
    expect(result.action.action).toBe('click');
  });

  it('strips markdown code blocks without language annotation', () => {
    const raw = '```\n{"action": {"action": "click", "selector": "@b1"}}\n```';
    const result = parseBrain(raw) as ParseResult;
    expect(result.action.action).toBe('click');
  });

  it('handles flat action format (action type as top-level string)', () => {
    const raw = JSON.stringify({
      action: 'click',
      selector: '@b1',
    });
    const result = parseBrain(raw) as ParseResult;
    expect(result.action.action).toBe('click');
    expect(result.action.selector).toBe('@b1');
  });

  it('handles completely invalid JSON gracefully — returns wait action', () => {
    const result = parseBrain('This is not JSON at all') as ParseResult;
    expect(result.action.action).toBe('wait');
    expect(result.reasoning).toContain('Malformed');
  });

  it('handles empty string gracefully', () => {
    const result = parseBrain('') as ParseResult;
    expect(result.action.action).toBe('wait');
    expect(result.reasoning).toContain('Malformed');
  });

  it('handles JSON without action field gracefully', () => {
    const result = parseBrain(JSON.stringify({ foo: 'bar' })) as ParseResult;
    expect(result.action.action).toBe('wait');
    expect(result.reasoning).toContain('Malformed');
  });

  it('handles unknown action type gracefully', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'teleport', destination: 'mars' },
    })) as ParseResult;
    expect(result.action.action).toBe('wait');
    expect(result.reasoning).toContain('Malformed');
  });
});

describe('Brain.parse — nextActions', () => {
  it('parses valid nextActions', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      nextActions: [
        { action: 'type', selector: '@t1', text: 'hello' },
      ],
    })) as ParseResult;
    expect(result.nextActions).toHaveLength(1);
    expect(result.nextActions![0].action).toBe('type');
  });

  it('filters invalid entries from nextActions', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      nextActions: [
        { action: 'type', selector: '@t1', text: 'hello' },
        { bad: 'entry' },
        null,
        42,
      ],
    })) as ParseResult;
    expect(result.nextActions).toHaveLength(1);
  });

  it('returns undefined when nextActions is not an array', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      nextActions: 'not-an-array',
    })) as ParseResult;
    expect(result.nextActions).toBeUndefined();
  });

  it('caps nextActions at 3 entries', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      nextActions: [
        { action: 'wait', ms: 100 },
        { action: 'wait', ms: 200 },
        { action: 'wait', ms: 300 },
        { action: 'wait', ms: 400 },
        { action: 'wait', ms: 500 },
      ],
    })) as ParseResult;
    expect(result.nextActions!.length).toBeLessThanOrEqual(3);
  });

  it('returns undefined when all nextActions entries are invalid', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click', selector: '@b1' },
      nextActions: [
        { action: 'unknown-action' },
        { nope: true },
      ],
    })) as ParseResult;
    expect(result.nextActions).toBeUndefined();
  });
});

describe('Brain.parse — action validation edge cases', () => {
  it('click requires selector', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'click' },
    })) as ParseResult;
    // Missing selector should cause validation failure → wait fallback
    expect(result.action.action).toBe('wait');
  });

  it('press requires selector and key', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'press', selector: '@t1' },
    })) as ParseResult;
    // Missing key → wait fallback
    expect(result.action.action).toBe('wait');
  });

  it('navigate requires url', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'navigate' },
    })) as ParseResult;
    expect(result.action.action).toBe('wait');
  });

  it('runScript requires script', () => {
    const result = parseBrain(JSON.stringify({
      action: { action: 'runScript' },
    })) as ParseResult;
    expect(result.action.action).toBe('wait');
  });
});

describe('Brain constructor and public API', () => {
  it('creates with default config', () => {
    const brain = new Brain();
    expect(brain.getHistory()).toEqual([]);
  });

  it('creates with custom config', () => {
    const brain = new Brain({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      vision: false,
      maxHistoryTurns: 5,
    });
    expect(brain.getHistory()).toEqual([]);
  });

  it('reset clears history', () => {
    const brain = new Brain();
    brain.injectFeedback('test feedback');
    expect(brain.getHistory().length).toBe(1);
    brain.reset();
    expect(brain.getHistory()).toEqual([]);
  });

  it('injectFeedback adds user message with [SYSTEM FEEDBACK] prefix', () => {
    const brain = new Brain();
    brain.injectFeedback('Agent is stuck');
    const history = brain.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('[SYSTEM FEEDBACK] Agent is stuck');
  });

  it('getHistory returns a copy, not the internal reference', () => {
    const brain = new Brain();
    brain.injectFeedback('test');
    const history1 = brain.getHistory();
    const history2 = brain.getHistory();
    expect(history1).not.toBe(history2);
    expect(history1).toEqual(history2);
  });
});
