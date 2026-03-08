import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TrajectoryStore } from '../src/memory/store.js';
import { TrajectoryAnalyzer } from '../src/memory/analyzer.js';
import { AppKnowledge } from '../src/memory/knowledge.js';
import { SelectorCache } from '../src/memory/selectors.js';
import { ProjectStore } from '../src/memory/project-store.js';
import type { TestSuiteResult, TestResult, Turn, Trajectory } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `abd-${prefix}-`));
}

function makeTurn(idx: number, opts: { error?: string; verified?: boolean; verificationFailure?: string; action?: Turn['action'] } = {}): Turn {
  return {
    turn: idx,
    state: { url: 'https://example.com/page', title: 'Test', snapshot: `snapshot-${idx}` },
    action: opts.action ?? { action: 'click', selector: `@btn${idx}` },
    durationMs: 500,
    error: opts.error,
    verified: opts.verified,
    verificationFailure: opts.verificationFailure,
  };
}

function makeTestResult(overrides: Partial<TestResult> & { turns?: Turn[]; goal?: string; success?: boolean; verified?: boolean }): TestResult {
  const turns = overrides.turns ?? [makeTurn(1), makeTurn(2)];
  return {
    testCase: {
      id: 'test-1',
      name: overrides.goal ?? 'test case',
      startUrl: 'https://example.com',
      goal: overrides.goal ?? 'complete the flow',
    },
    agentResult: {
      success: overrides.success ?? true,
      turns,
      totalMs: turns.reduce((s, t) => s + t.durationMs, 0),
    },
    agentSuccess: overrides.success ?? true,
    verified: overrides.verified ?? true,
    verdict: overrides.verified === false ? 'failed' : 'passed',
    turnsUsed: turns.length,
    tokensUsed: 1000,
    durationMs: turns.reduce((s, t) => s + t.durationMs, 0),
    startedAt: new Date(),
    endedAt: new Date(),
    ...overrides,
  } as TestResult;
}

function makeSuiteResult(results: TestResult[]): TestSuiteResult {
  const passed = results.filter((r) => r.verified).length;
  return {
    model: 'gpt-5.2',
    timestamp: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      skipped: 0,
      passRate: results.length > 0 ? passed / results.length : 1,
      avgTurns: results.reduce((s, r) => s + r.turnsUsed, 0) / results.length || 0,
      avgTokens: 1000,
      avgDurationMs: 1000,
      p50DurationMs: 1000,
      p95DurationMs: 2000,
      totalDurationMs: results.reduce((s, r) => s + r.durationMs, 0),
    },
  };
}

// ─── TrajectoryStore ────────────────────────────────────────────────────────

describe('TrajectoryStore', () => {
  it('saves and loads a trajectory', () => {
    const dir = tmpDir('store-save');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.1 });

    const turns: Turn[] = [
      makeTurn(1),
      makeTurn(2),
      { ...makeTurn(3), action: { action: 'complete', result: 'done' } },
    ];

    const saved = store.save('create a new project', turns, true, 'gpt-5.2');
    expect(saved.id).toMatch(/^traj_/);
    expect(saved.goal).toBe('create a new project');
    expect(saved.success).toBe(true);
    // complete/abort actions are filtered from steps
    expect(saved.steps.length).toBe(2);

    const all = store.loadAll();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(saved.id);
  });

  it('findBestMatch returns the most similar successful trajectory', () => {
    const dir = tmpDir('store-match');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.3 });

    store.save('create a new project in dashboard', [makeTurn(1)], true, 'gpt-5.2');
    store.save('delete the old project', [makeTurn(2)], true, 'gpt-5.2');

    const match = store.findBestMatch('create a new project');
    expect(match).not.toBeNull();
    expect(match!.goal).toBe('create a new project in dashboard');
  });

  it('findBestMatch excludes failed trajectories', () => {
    const dir = tmpDir('store-fail');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.1 });

    store.save('create project', [makeTurn(1)], false, 'gpt-5.2');

    const match = store.findBestMatch('create project');
    expect(match).toBeNull();
  });

  it('findBestMatch returns null when similarity is below threshold', () => {
    const dir = tmpDir('store-thresh');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.9 });

    store.save('navigate to settings page', [makeTurn(1)], true, 'gpt-5.2');

    const match = store.findBestMatch('completely unrelated goal about weather');
    expect(match).toBeNull();
  });

  it('formatAsReference produces readable output', () => {
    const dir = tmpDir('store-fmt');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.1 });

    const turns: Turn[] = [
      { ...makeTurn(1), action: { action: 'click', selector: '@btn1' }, verified: true },
      { ...makeTurn(2), action: { action: 'navigate', url: 'https://example.com/next' } },
    ];

    const saved = store.save('open the dashboard', turns, true, 'gpt-5.2');
    const formatted = store.formatAsReference(saved);

    expect(formatted).toContain('Goal: open the dashboard');
    expect(formatted).toContain('Steps (2 total)');
    expect(formatted).toContain('click @btn1');
    expect(formatted).toContain('navigate to https://example.com/next');
    expect(formatted).toContain('[verified]');
  });

  it('cache is invalidated after save', () => {
    const dir = tmpDir('store-cache');
    const store = new TrajectoryStore(dir, { similarityThreshold: 0.1 });

    expect(store.loadAll().length).toBe(0);
    store.save('goal 1', [makeTurn(1)], true, 'gpt-5.2');
    expect(store.loadAll().length).toBe(1);
    store.save('goal 2', [makeTurn(2)], true, 'gpt-5.2');
    expect(store.loadAll().length).toBe(2);
  });
});

// ─── TrajectoryAnalyzer ─────────────────────────────────────────────────────

describe('TrajectoryAnalyzer', () => {
  let analyzer: TrajectoryAnalyzer;

  beforeEach(() => {
    analyzer = new TrajectoryAnalyzer();
  });

  it('analyzes a simple passing suite', () => {
    const suite = makeSuiteResult([
      makeTestResult({ verified: true, turns: [makeTurn(1), makeTurn(2)] }),
    ]);

    const analysis = analyzer.analyze(suite);
    expect(analysis.passRate).toBe(1);
    expect(analysis.turnEfficiency.totalTurns).toBe(2);
    expect(analysis.turnEfficiency.wastedTurns).toBe(0);
    expect(analysis.turnEfficiency.efficiencyRate).toBe(1);
  });

  it('counts error turns as wasted', () => {
    const suite = makeSuiteResult([
      makeTestResult({
        verified: true,
        turns: [
          makeTurn(1),
          makeTurn(2, { error: 'selector not found' }),
          makeTurn(3),
        ],
      }),
    ]);

    const analysis = analyzer.analyze(suite);
    expect(analysis.turnEfficiency.wastedTurns).toBe(1);
    expect(analysis.turnEfficiency.productiveTurns).toBe(2);
  });

  it('detects verification gaps (agent says success but ground-truth disagrees)', () => {
    const suite = makeSuiteResult([
      makeTestResult({ success: true, verified: true }),
      makeTestResult({ success: true, verified: false }),
      makeTestResult({ success: true, verified: false }),
    ]);

    const analysis = analyzer.analyze(suite);
    expect(analysis.verificationGaps.agentSaysSuccess).toBe(3);
    expect(analysis.verificationGaps.groundTruthConfirms).toBe(1);
    // 2 out of 3 are false positives
    expect(analysis.verificationGaps.falsePositiveRate).toBeCloseTo(2 / 3, 2);
  });

  it('tracks action patterns with failure rates', () => {
    const suite = makeSuiteResult([
      makeTestResult({
        turns: [
          makeTurn(1, { action: { action: 'click', selector: '@btn1' } }),
          makeTurn(2, { action: { action: 'click', selector: '@btn1' }, error: 'not found' }),
          makeTurn(3, { action: { action: 'type', selector: '@input1', text: 'hello' } }),
        ],
      }),
    ]);

    const analysis = analyzer.analyze(suite);
    const clickPattern = analysis.actionPatterns.find((p) => p.action === 'click');
    expect(clickPattern).toBeDefined();
    expect(clickPattern!.occurrences).toBe(2);
    expect(clickPattern!.failures).toBe(1);
    expect(clickPattern!.failureRate).toBeCloseTo(0.5, 2);
  });

  it('detects stuck loops in waste breakdown', () => {
    const sameAction: Turn['action'] = { action: 'click', selector: '@same' };
    const suite = makeSuiteResult([
      makeTestResult({
        turns: [
          makeTurn(1, { action: sameAction }),
          makeTurn(2, { action: sameAction }),
          makeTurn(3, { action: sameAction }),
        ],
      }),
    ]);

    const analysis = analyzer.analyze(suite);
    const stuckLoops = analysis.wasteBreakdown.filter((w) => w.category === 'stuck-loop');
    expect(stuckLoops.length).toBeGreaterThan(0);
  });

  it('detects stale ref errors in waste breakdown', () => {
    const suite = makeSuiteResult([
      makeTestResult({
        turns: [
          makeTurn(1, { error: 'Stale ref @btn1' }),
          makeTurn(2),
        ],
      }),
    ]);

    const analysis = analyzer.analyze(suite);
    const staleRefs = analysis.wasteBreakdown.filter((w) => w.category === 'stale-ref');
    expect(staleRefs.length).toBe(1);
  });

  it('generateHints returns empty string for healthy suite', () => {
    const suite = makeSuiteResult([
      makeTestResult({ verified: true, turns: [makeTurn(1), makeTurn(2)] }),
    ]);
    const analysis = analyzer.analyze(suite);
    const hints = analyzer.generateHints(analysis);
    expect(hints).toBe('');
  });

  it('generateHints flags low efficiency', () => {
    const suite = makeSuiteResult([
      makeTestResult({
        verified: true,
        turns: [
          makeTurn(1, { error: 'e1' }),
          makeTurn(2, { error: 'e2' }),
          makeTurn(3, { error: 'e3' }),
          makeTurn(4),
        ],
      }),
    ]);
    const analysis = analyzer.analyze(suite);
    const hints = analyzer.generateHints(analysis);
    expect(hints).toContain('EFFICIENCY WARNING');
  });

  it('generateHints flags high false-positive rate', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeTestResult({
        testCase: { id: `t${i}`, name: `test ${i}`, startUrl: 'https://example.com', goal: `goal ${i}` },
        success: true,
        verified: i < 2, // only 2 out of 5 confirmed
      }),
    );
    const suite = makeSuiteResult(results);
    const analysis = analyzer.analyze(suite);
    const hints = analyzer.generateHints(analysis);
    expect(hints).toContain('ACCURACY WARNING');
  });

  it('extracts top failure reasons', () => {
    const suite = makeSuiteResult([
      makeTestResult({
        verified: false,
        verdict: 'element not found',
        criteriaResults: [{ criterion: 'check', passed: false, detail: 'button missing from page' }],
      }),
    ]);
    const analysis = analyzer.analyze(suite);
    expect(analysis.topFailureReasons).toContain('button missing from page');
  });
});

// ─── AppKnowledge ───────────────────────────────────────────────────────────

describe('AppKnowledge', () => {
  it('starts with no facts for a fresh domain', () => {
    const dir = tmpDir('knowledge');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');
    expect(kb.getFacts()).toEqual([]);
  });

  it('records and retrieves a fact', () => {
    const dir = tmpDir('knowledge-record');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('timing', 'page-load', '2000ms');

    const facts = kb.getFacts();
    expect(facts.length).toBe(1);
    expect(facts[0].type).toBe('timing');
    expect(facts[0].key).toBe('page-load');
    expect(facts[0].value).toBe('2000ms');
    expect(facts[0].confidence).toBe(0.6);
    expect(facts[0].sources).toBe(1);
  });

  it('boosts confidence when same fact is confirmed', () => {
    const dir = tmpDir('knowledge-boost');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('selector', 'submit-btn', '[data-testid="submit"]');
    const initial = kb.getFact('selector', 'submit-btn')!.confidence;

    kb.recordFact('selector', 'submit-btn', '[data-testid="submit"]');
    const boosted = kb.getFact('selector', 'submit-btn')!.confidence;

    expect(boosted).toBeGreaterThan(initial);
    expect(kb.getFact('selector', 'submit-btn')!.sources).toBe(2);
  });

  it('decays confidence on contradicting value and adds new fact', () => {
    const dir = tmpDir('knowledge-contradict');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('timing', 'animation', '300ms');
    const oldConf = kb.getFact('timing', 'animation')!.confidence;

    kb.recordFact('timing', 'animation', '500ms');

    // Old fact should have decayed
    const allTimingFacts = kb.getFactsByType('timing');
    const oldFact = allTimingFacts.find((f) => f.value === '300ms');
    const newFact = allTimingFacts.find((f) => f.value === '500ms');

    expect(oldFact).toBeDefined();
    expect(oldFact!.confidence).toBeLessThan(oldConf);
    expect(oldFact!.confidence).toBe(oldConf * 0.5);
    expect(newFact).toBeDefined();
    expect(newFact!.confidence).toBe(0.6);
  });

  it('prunes facts below 0.1 confidence', () => {
    const dir = tmpDir('knowledge-prune');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('quirk', 'lazy-load', 'true');
    // Contradict repeatedly to drive confidence below 0.1
    // 0.6 * 0.5 = 0.3, 0.3 * 0.5 = 0.15, 0.15 * 0.5 = 0.075 < 0.1
    kb.recordFact('quirk', 'lazy-load', 'false');   // old -> 0.3
    kb.recordFact('quirk', 'lazy-load', 'maybe');    // old "false" -> 0.3, old "true" -> 0.15
    kb.recordFact('quirk', 'lazy-load', 'nope');     // old "maybe" -> 0.3, old "false" -> 0.15, old "true" -> 0.075

    const allFacts = kb.getFacts(0.0); // get everything above 0
    const prunedTrue = allFacts.find((f) => f.key === 'lazy-load' && f.value === 'true');
    expect(prunedTrue).toBeUndefined(); // should have been pruned
  });

  it('filters facts by type', () => {
    const dir = tmpDir('knowledge-type');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('timing', 'load', '1s');
    kb.recordFact('selector', 'btn', '@submit');
    kb.recordFact('pattern', 'auth', 'click login then wait');

    expect(kb.getFactsByType('timing').length).toBe(1);
    expect(kb.getFactsByType('selector').length).toBe(1);
    expect(kb.getFactsByType('pattern').length).toBe(1);
    expect(kb.getFactsByType('quirk').length).toBe(0);
  });

  it('filters facts by minimum confidence', () => {
    const dir = tmpDir('knowledge-minconf');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('timing', 'load', '1s'); // confidence 0.6

    expect(kb.getFacts(0.5).length).toBe(1);
    expect(kb.getFacts(0.7).length).toBe(0);
  });

  it('recordFacts handles batch recording', () => {
    const dir = tmpDir('knowledge-batch');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFacts([
      { type: 'timing', key: 'load', value: '1s' },
      { type: 'selector', key: 'btn', value: '@submit' },
      { type: 'quirk', key: 'shadow-dom', value: 'true' },
    ]);

    expect(kb.getFacts().length).toBe(3);
  });

  it('formatForBrain returns empty string when no high-confidence facts', () => {
    const dir = tmpDir('knowledge-fmt-empty');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');
    expect(kb.formatForBrain()).toBe('');
  });

  it('formatForBrain groups facts by type', () => {
    const dir = tmpDir('knowledge-fmt');
    const kb = new AppKnowledge(path.join(dir, 'knowledge.json'), 'example.com');

    kb.recordFact('timing', 'load', '2s');
    kb.recordFact('selector', 'submit', '[data-testid="submit"]');
    // Boost both to ensure they pass the 0.5 threshold for formatForBrain
    kb.recordFact('timing', 'load', '2s');
    kb.recordFact('selector', 'submit', '[data-testid="submit"]');

    const output = kb.formatForBrain();
    expect(output).toContain('APP KNOWLEDGE');
    expect(output).toContain('TIMING:');
    expect(output).toContain('SELECTOR:');
    expect(output).toContain('load: 2s');
  });

  it('persists and loads from disk', () => {
    const dir = tmpDir('knowledge-persist');
    const filePath = path.join(dir, 'knowledge.json');

    const kb1 = new AppKnowledge(filePath, 'example.com');
    kb1.recordFact('timing', 'load', '3s');
    kb1.save();

    const kb2 = new AppKnowledge(filePath, 'example.com');
    const facts = kb2.getFacts();
    expect(facts.length).toBe(1);
    expect(facts[0].value).toBe('3s');
  });
});

// ─── SelectorCache ──────────────────────────────────────────────────────────

describe('SelectorCache', () => {
  it('starts with no entries', () => {
    const dir = tmpDir('selcache-empty');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));
    expect(cache.getAll()).toEqual([]);
  });

  it('records a successful @ref selector', () => {
    const dir = tmpDir('selcache-ref');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    cache.recordSuccess('button "Submit"', '@ref123');
    const entry = cache.lookup('button "Submit"');
    expect(entry).toBeDefined();
    expect(entry!.lastRef).toBe('@ref123');
    expect(entry!.stableSelector).toBeUndefined();
    expect(entry!.successCount).toBe(1);
  });

  it('records a stable selector (non-@ref)', () => {
    const dir = tmpDir('selcache-stable');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    cache.recordSuccess('button "Submit"', '[data-testid="submit"]');
    const entry = cache.lookup('button "Submit"');
    expect(entry!.stableSelector).toBe('[data-testid="submit"]');
    expect(entry!.lastRef).toBeUndefined();
  });

  it('increments success count on repeated use', () => {
    const dir = tmpDir('selcache-inc');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    cache.recordSuccess('button "Save"', '@r1');
    cache.recordSuccess('button "Save"', '@r2');
    cache.recordSuccess('button "Save"', '[data-testid="save"]');

    const entry = cache.lookup('button "Save"');
    expect(entry!.successCount).toBe(3);
    expect(entry!.lastRef).toBe('@r2');
    expect(entry!.stableSelector).toBe('[data-testid="save"]');
  });

  it('getAll returns entries sorted by success count', () => {
    const dir = tmpDir('selcache-sort');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    cache.recordSuccess('button "A"', '@a');
    cache.recordSuccess('button "B"', '@b');
    cache.recordSuccess('button "B"', '@b');
    cache.recordSuccess('button "C"', '@c');
    cache.recordSuccess('button "C"', '@c');
    cache.recordSuccess('button "C"', '@c');

    const all = cache.getAll();
    expect(all[0].element).toBe('button "C"');
    expect(all[1].element).toBe('button "B"');
    expect(all[2].element).toBe('button "A"');
  });

  it('lookup returns undefined for unknown elements', () => {
    const dir = tmpDir('selcache-miss');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));
    expect(cache.lookup('button "Unknown"')).toBeUndefined();
  });

  it('formatForBrain returns empty string when no entries exist', () => {
    const dir = tmpDir('selcache-fmt-empty');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));
    expect(cache.formatForBrain()).toBe('');
  });

  it('formatForBrain renders known selectors with usage counts', () => {
    const dir = tmpDir('selcache-fmt');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    cache.recordSuccess('button "Submit"', '[data-testid="submit"]');
    cache.recordSuccess('button "Submit"', '[data-testid="submit"]');

    const output = cache.formatForBrain();
    expect(output).toContain('KNOWN SELECTORS');
    expect(output).toContain('button "Submit"');
    expect(output).toContain('[data-testid="submit"]');
    expect(output).toContain('used 2x');
  });

  it('formatForBrain respects limit parameter', () => {
    const dir = tmpDir('selcache-limit');
    const cache = new SelectorCache(path.join(dir, 'selectors.json'));

    for (let i = 0; i < 5; i++) {
      cache.recordSuccess(`button "Btn${i}"`, `@ref${i}`);
    }

    const output = cache.formatForBrain(2);
    // Count the number of "button" lines (should be limited to 2)
    const lines = output.split('\n').filter((l) => l.includes('button'));
    expect(lines.length).toBe(2);
  });

  it('persists and loads from disk', () => {
    const dir = tmpDir('selcache-persist');
    const filePath = path.join(dir, 'selectors.json');

    const cache1 = new SelectorCache(filePath);
    cache1.recordSuccess('link "Home"', '@h1');
    cache1.save();

    const cache2 = new SelectorCache(filePath);
    const entry = cache2.lookup('link "Home"');
    expect(entry).toBeDefined();
    expect(entry!.lastRef).toBe('@h1');
  });
});

// ─── ProjectStore ───────────────────────────────────────────────────────────

describe('ProjectStore', () => {
  it('creates the directory structure on init', () => {
    const dir = tmpDir('projstore');
    const root = path.join(dir, 'memory');
    const store = new ProjectStore(root);

    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'domains'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'runs'))).toBe(true);
  });

  it('getRoot returns the configured root', () => {
    const dir = tmpDir('projstore-root');
    const root = path.join(dir, 'memory');
    const store = new ProjectStore(root);
    expect(store.getRoot()).toBe(root);
  });

  it('getDomainDir sanitizes URLs into safe directory names', () => {
    const dir = tmpDir('projstore-domain');
    const store = new ProjectStore(path.join(dir, 'memory'));

    const domainDir = store.getDomainDir('https://localhost:5173/foo/bar');
    expect(domainDir).toContain('localhost_5173');
    expect(fs.existsSync(domainDir)).toBe(true);
  });

  it('getTrajectoryDir creates trajectories subdirectory', () => {
    const dir = tmpDir('projstore-traj');
    const store = new ProjectStore(path.join(dir, 'memory'));

    const trajDir = store.getTrajectoryDir('https://example.com');
    expect(trajDir).toContain('trajectories');
    expect(fs.existsSync(trajDir)).toBe(true);
  });

  it('getKnowledgePath returns domain-scoped knowledge path', () => {
    const dir = tmpDir('projstore-kb');
    const store = new ProjectStore(path.join(dir, 'memory'));

    const kbPath = store.getKnowledgePath('https://example.com');
    expect(kbPath).toContain('knowledge.json');
    expect(kbPath).toContain('example.com');
  });

  it('getSelectorCachePath returns domain-scoped selector path', () => {
    const dir = tmpDir('projstore-sel');
    const store = new ProjectStore(path.join(dir, 'memory'));

    const selPath = store.getSelectorCachePath('https://app.example.com:3000');
    expect(selPath).toContain('selectors.json');
    expect(selPath).toContain('app.example.com_3000');
  });

  it('saveHints and loadHints round-trip', () => {
    const dir = tmpDir('projstore-hints');
    const store = new ProjectStore(path.join(dir, 'memory'));

    expect(store.loadHints()).toBeNull();

    store.saveHints('Always use data-testid selectors');
    const loaded = store.loadHints();
    expect(loaded).toBe('Always use data-testid selectors');
  });

  it('saveRunSummary persists a run file', () => {
    const dir = tmpDir('projstore-run');
    const store = new ProjectStore(path.join(dir, 'memory'));

    const suite = makeSuiteResult([
      makeTestResult({ verified: true }),
    ]);

    store.saveRunSummary(suite);

    const runFiles = fs.readdirSync(path.join(dir, 'memory', 'runs'));
    expect(runFiles.length).toBe(1);
    expect(runFiles[0]).toMatch(/^run_.*\.json$/);

    const content = JSON.parse(fs.readFileSync(path.join(dir, 'memory', 'runs', runFiles[0]), 'utf-8'));
    expect(content.passed).toBe(1);
    expect(content.model).toBe('gpt-5.2');
  });

  it('handles invalid URLs gracefully in getDomainDir', () => {
    const dir = tmpDir('projstore-invalid');
    const store = new ProjectStore(path.join(dir, 'memory'));

    // Should not throw even with an invalid URL
    const domainDir = store.getDomainDir('not-a-valid-url');
    expect(fs.existsSync(domainDir)).toBe(true);
  });
});
