import { describe, expect, it } from 'vitest';
import { runOverridePipeline } from '../src/override-pipeline.js';
import type { OverrideCandidate, OverrideContext, OverrideProducer } from '../src/override-pipeline.js';
import type { PageState } from '../src/types.js';

const baseState: PageState = {
  url: 'https://example.com/search?q=test',
  title: 'Search Results',
  snapshot: '- link "Result A" [ref=r1]\n- link "Result B" [ref=r2]',
};

const baseCtx: OverrideContext = {
  state: baseState,
  goal: 'Find the latest press release about climate change',
  action: { action: 'click', selector: '@r1' },
};

function makeProducer(candidate: OverrideCandidate | undefined): OverrideProducer {
  return () => candidate;
}

function makeCandidate(overrides: Partial<OverrideCandidate> = {}): OverrideCandidate {
  return {
    name: 'test-override',
    action: { action: 'click', selector: '@r1' },
    expectedEffect: 'URL should change',
    feedback: 'Test feedback',
    score: 10,
    reasoningTag: 'POLICY OVERRIDE',
    ...overrides,
  };
}

describe('runOverridePipeline', () => {
  it('returns undefined when no producers match', () => {
    const result = runOverridePipeline(baseCtx, [
      makeProducer(undefined),
      makeProducer(undefined),
    ]);
    expect(result).toBeUndefined();
  });

  it('returns undefined with empty producer list', () => {
    const result = runOverridePipeline(baseCtx, []);
    expect(result).toBeUndefined();
  });

  it('returns the only candidate when one producer matches', () => {
    const candidate = makeCandidate({ name: 'only-match', score: 42 });
    const result = runOverridePipeline(baseCtx, [
      makeProducer(undefined),
      makeProducer(candidate),
      makeProducer(undefined),
    ]);
    expect(result).toEqual(candidate);
  });

  it('selects the highest-scoring candidate', () => {
    const low = makeCandidate({ name: 'low', score: 10 });
    const high = makeCandidate({ name: 'high', score: 100 });
    const mid = makeCandidate({ name: 'mid', score: 50 });

    const result = runOverridePipeline(baseCtx, [
      makeProducer(low),
      makeProducer(high),
      makeProducer(mid),
    ]);
    expect(result?.name).toBe('high');
    expect(result?.score).toBe(100);
  });

  it('selects first candidate on tie (stable sort)', () => {
    const a = makeCandidate({ name: 'first-added', score: 50 });
    const b = makeCandidate({ name: 'second-added', score: 50 });

    const result = runOverridePipeline(baseCtx, [
      makeProducer(a),
      makeProducer(b),
    ]);
    // Both have score 50; sort is stable so first in array wins
    expect(result?.name).toBe('first-added');
  });

  it('passes context to each producer', () => {
    const receivedContexts: OverrideContext[] = [];
    const spy: OverrideProducer = (ctx) => {
      receivedContexts.push(ctx);
      return undefined;
    };

    runOverridePipeline(baseCtx, [spy, spy, spy]);
    expect(receivedContexts).toHaveLength(3);
    expect(receivedContexts[0]).toBe(baseCtx);
  });

  it('handles producers that throw by propagating', () => {
    const badProducer: OverrideProducer = () => { throw new Error('boom'); };
    expect(() => runOverridePipeline(baseCtx, [badProducer])).toThrow('boom');
  });

  it('works with terminal override actions (complete)', () => {
    const terminal = makeCandidate({
      name: 'partner-complete',
      action: { action: 'complete', result: 'Partner template detected' },
      score: 100,
      reasoningTag: 'POLICY OVERRIDE',
    });

    const result = runOverridePipeline(baseCtx, [
      makeProducer(makeCandidate({ score: 30 })),
      makeProducer(terminal),
    ]);
    expect(result?.name).toBe('partner-complete');
    expect(result?.action.action).toBe('complete');
  });

  it('correctly handles all OverrideContext fields', () => {
    const richCtx: OverrideContext = {
      ...baseCtx,
      allowedDomains: ['example.com'],
      visibleLinkMatch: { ref: '@r1', text: 'Result A', score: 15 },
      scoutLinkRecommendation: { ref: '@r2', text: 'Result B', confidence: 0.9, reasoning: 'high match' },
      branchLinkRecommendation: { ref: '@r3', text: 'Result C', confidence: 0.7, reasoning: 'branch match' },
      aiTanglePartnerCompletion: { result: 'partner', feedback: 'Template visible' },
      aiTangleOutputCompletion: { result: 'output', feedback: 'Output verified' },
    };

    let receivedCtx: OverrideContext | undefined;
    const spy: OverrideProducer = (ctx) => { receivedCtx = ctx; return undefined; };
    runOverridePipeline(richCtx, [spy]);

    expect(receivedCtx?.allowedDomains).toEqual(['example.com']);
    expect(receivedCtx?.visibleLinkMatch?.score).toBe(15);
    expect(receivedCtx?.scoutLinkRecommendation?.confidence).toBe(0.9);
    expect(receivedCtx?.branchLinkRecommendation?.confidence).toBe(0.7);
    expect(receivedCtx?.aiTanglePartnerCompletion?.result).toBe('partner');
    expect(receivedCtx?.aiTangleOutputCompletion?.result).toBe('output');
  });

  it('selects across many candidates efficiently', () => {
    const producers: OverrideProducer[] = [];
    for (let i = 0; i < 50; i++) {
      producers.push(makeProducer(makeCandidate({ name: `p${i}`, score: i })));
    }
    const result = runOverridePipeline(baseCtx, producers);
    expect(result?.name).toBe('p49');
    expect(result?.score).toBe(49);
  });
});
