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

  // OpenAI-compat gateways (router.tangle.tools, LiteLLM proxies) sometimes
  // return JSON wrapped in prose ("Here's your response:\n{...}") that
  // markdown-fence stripping doesn't catch. The parser must recover rather
  // than burn a turn on an unparseable response.
  it('extracts JSON object from prose preamble', () => {
    const brain = new Brain();
    const parsed = (brain as unknown as { parse: (raw: string) => unknown }).parse(
      `Sure, here's my response:\n{"action":{"action":"click","selector":"@b1"},"reasoning":"found it"}\nLet me know if you need anything else.`,
    ) as { action: { action: string }; reasoning?: string };

    expect(parsed.action.action).toBe('click');
    expect(parsed.reasoning).toBe('found it');
  });

  it('falls back to wait when no JSON object present', () => {
    const brain = new Brain();
    const parsed = (brain as unknown as { parse: (raw: string) => unknown }).parse(
      `I cannot produce JSON right now, sorry about that.`,
    ) as { action: { action: string; ms?: number }; reasoning?: string };

    expect(parsed.action.action).toBe('wait');
    expect(parsed.reasoning).toMatch(/Malformed LLM JSON response/);
  });
});

