import { describe, expect, it } from 'vitest';
import {
  detectAiTangleVerifiedOutputState,
  detectAiTanglePartnerTemplateVisibleState,
  shouldEscalateVision,
} from '../src/runner/page-analysis.js';
import type { AgentConfig, PageState, Scenario, Turn } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<PageState> = {}): PageState {
  return {
    url: 'https://example.com',
    title: 'Example',
    snapshot: '',
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> & { turn: number }): Turn {
  return {
    state: makeState(),
    action: { action: 'click', selector: '@b1' },
    durationMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectAiTangleVerifiedOutputState
// ---------------------------------------------------------------------------

describe('detectAiTangleVerifiedOutputState', () => {
  it('returns undefined when goal does not require verified output', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/abc',
      snapshot: 'code preview',
    });
    expect(detectAiTangleVerifiedOutputState(state, 'Just browse around')).toBeUndefined();
  });

  it('returns undefined when URL is not AI Tangle chat', () => {
    const state = makeState({
      url: 'https://other-site.com/page',
      snapshot: 'code preview',
    });
    expect(
      detectAiTangleVerifiedOutputState(state, 'Reach a verified visible output state'),
    ).toBeUndefined();
  });

  it('returns undefined when no output surface is detected', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/abc',
      snapshot: 'nothing relevant here',
    });
    expect(
      detectAiTangleVerifiedOutputState(state, 'Reach a verified visible output state'),
    ).toBeUndefined();
  });

  it('detects workspace tabs (code + preview)', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/abc',
      snapshot: '- tab "Code" [ref=t1]\n- tab "Preview" [ref=t2]',
    });
    const result = detectAiTangleVerifiedOutputState(state, 'Reach a verified visible output state');
    expect(result).toBeDefined();
    expect(result!.result).toContain('Code/Preview workspace is visible');
    expect(result!.feedback).toContain('already satisfied');
  });

  it('detects "fresh start" placeholder', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/xyz',
      snapshot: '- text "Fresh start"',
    });
    const result = detectAiTangleVerifiedOutputState(
      state,
      'reach a verified output state with usable output',
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain('Fresh start');
  });

  it('detects "waiting for files" status', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/xyz',
      snapshot: '- text "Waiting for files to appear"',
    });
    const result = detectAiTangleVerifiedOutputState(
      state,
      'Reach a verified visible output state',
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain('Waiting for files');
  });

  it('detects fork control', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/xyz',
      snapshot: '- button "Fork" [ref=b1]',
    });
    const result = detectAiTangleVerifiedOutputState(
      state,
      'Reach a verified visible output state',
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain('Fork');
  });

  it('includes URL evidence in result', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/my-chat-id',
      snapshot: 'Code Preview Fork',
    });
    const result = detectAiTangleVerifiedOutputState(
      state,
      'Reach a verified visible output state',
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain('ai.tangle.tools/chat/my-chat-id');
  });

  it('matches goal variants: "usable output"', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/chat/abc',
      snapshot: 'Code Preview',
    });
    expect(
      detectAiTangleVerifiedOutputState(state, 'produce usable output on the Blueprint'),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// detectAiTanglePartnerTemplateVisibleState
// ---------------------------------------------------------------------------

describe('detectAiTanglePartnerTemplateVisibleState', () => {
  it('returns undefined when goal does not require template visibility', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot: '- heading "Coinbase" [ref=h1]\n' +
        '- button "View Coinbase templates A" [ref=b1]\n' +
        '- button "View Coinbase templates B" [ref=b2]\n' +
        '- button "View Coinbase templates C" [ref=b3]\n',
    });
    expect(detectAiTanglePartnerTemplateVisibleState(state, 'Do something else')).toBeUndefined();
  });

  it('returns undefined when URL is not a partner page', () => {
    const state = makeState({
      url: 'https://other-site.com',
      snapshot: '- heading "Coinbase" [ref=h1]',
    });
    expect(
      detectAiTanglePartnerTemplateVisibleState(state, 'Verify Coinbase templates are visible'),
    ).toBeUndefined();
  });

  it('returns undefined when partner heading is missing', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot:
        '- button "View Coinbase templates A" [ref=b1]\n' +
        '- button "View Coinbase templates B" [ref=b2]\n' +
        '- button "View Coinbase templates C" [ref=b3]\n',
    });
    expect(
      detectAiTanglePartnerTemplateVisibleState(state, 'Verify Coinbase templates are visible'),
    ).toBeUndefined();
  });

  it('returns undefined when fewer than 3 template buttons', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot:
        '- heading "Coinbase" [ref=h1]\n' +
        '- button "View Coinbase templates A" [ref=b1]\n' +
        '- button "View Coinbase templates B" [ref=b2]\n',
    });
    expect(
      detectAiTanglePartnerTemplateVisibleState(state, 'Verify Coinbase templates are visible'),
    ).toBeUndefined();
  });

  it('detects valid partner template visible state', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot:
        '- heading "Coinbase Partner Hub" [ref=h1]\n' +
        '- button "View Coinbase templates Alpha" [ref=b1]\n' +
        '- button "View Coinbase templates Beta" [ref=b2]\n' +
        '- button "View Coinbase templates Gamma" [ref=b3]\n',
    });
    const result = detectAiTanglePartnerTemplateVisibleState(
      state,
      'Verify Coinbase templates are visible',
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain('Coinbase Partner Hub');
    expect(result!.result).toContain('template buttons');
    expect(result!.feedback).toContain('already satisfied');
  });

  it('matches goal variant: "templates are visible"', () => {
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot:
        '- heading "Coinbase" [ref=h1]\n' +
        '- button "View Coinbase templates A" [ref=b1]\n' +
        '- button "View Coinbase templates B" [ref=b2]\n' +
        '- button "View Coinbase templates C" [ref=b3]\n',
    });
    expect(
      detectAiTanglePartnerTemplateVisibleState(state, 'check that templates are visible'),
    ).toBeDefined();
  });

  it('caps evidence at 5 template buttons', () => {
    const buttons = Array.from({ length: 7 }, (_, i) =>
      `- button "View Coinbase templates ${i}" [ref=b${i}]`
    ).join('\n');
    const state = makeState({
      url: 'https://ai.tangle.tools/partner/coinbase',
      snapshot: `- heading "Coinbase" [ref=h1]\n${buttons}`,
    });
    const result = detectAiTanglePartnerTemplateVisibleState(
      state,
      'verify templates are visible',
    );
    expect(result).toBeDefined();
    // Evidence should mention at most 5 template buttons
    const matches = result!.result.match(/View Coinbase templates/g);
    expect(matches!.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// shouldEscalateVision
// ---------------------------------------------------------------------------

describe('shouldEscalateVision', () => {
  const defaultInput = () => ({
    config: {} as AgentConfig,
    state: makeState(),
    turns: [] as Turn[],
    scenario: { goal: 'test' } as Scenario,
    currentTurn: 5,
    maxTurns: 20,
    supervisorSignalSeverity: 'none' as const,
    extraContext: '',
  });

  it('returns false when strategy is "never"', () => {
    const input = { ...defaultInput(), config: { visionStrategy: 'never' as const } };
    expect(shouldEscalateVision(input)).toBe(false);
  });

  it('returns true when strategy is "always"', () => {
    const input = { ...defaultInput(), config: { visionStrategy: 'always' as const } };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true when vision is explicitly enabled (default strategy)', () => {
    const input = { ...defaultInput(), config: { vision: true } };
    // vision=true with no visionStrategy → 'always'
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns false in auto mode when nothing triggers escalation', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      currentTurn: 5,
      maxTurns: 20,
    };
    expect(shouldEscalateVision(input)).toBe(false);
  });

  it('returns true in auto mode when recent turns have errors', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      turns: [
        makeTurn({ turn: 3, error: 'selector not found' }),
        makeTurn({ turn: 4 }),
      ],
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true in auto mode when recent turns have verification failures', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      turns: [
        makeTurn({ turn: 3 }),
        makeTurn({ turn: 4, verificationFailure: 'Expected effect not achieved' }),
      ],
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true when modal-like content is detected', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      state: makeState({ snapshot: '- dialog "Confirm" [ref=d1]' }),
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true when low turns remaining', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      currentTurn: 19,
      maxTurns: 20,
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true when supervisor signal is not none', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      supervisorSignalSeverity: 'soft' as const,
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true for stalled search with repeated location', () => {
    const url = 'https://example.com/search?q=test';
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      state: makeState({ url, snapshot: 'search results for test' }),
      turns: [
        makeTurn({ turn: 3, state: makeState({ url }) }),
        makeTurn({ turn: 4, state: makeState({ url }) }),
      ],
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns true for search stalled at turn >= 6', () => {
    const input = {
      ...defaultInput(),
      config: { visionStrategy: 'auto' as const, vision: true },
      state: makeState({ snapshot: 'search results page' }),
      currentTurn: 7,
    };
    expect(shouldEscalateVision(input)).toBe(true);
  });

  it('returns false when vision is disabled', () => {
    const input = {
      ...defaultInput(),
      config: { vision: false },
    };
    expect(shouldEscalateVision(input)).toBe(false);
  });
});
