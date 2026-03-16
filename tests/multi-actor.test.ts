import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultiActorSession, Actor } from '../src/multi-actor.js';
import type { MultiActorSessionConfig } from '../src/multi-actor.js';
import type { AgentResult, Turn, Scenario } from '../src/types.js';

// ── Mocks ──

/** Minimal mock that satisfies the Browser interface for context creation */
function mockBrowser() {
  const contexts: ReturnType<typeof mockContext>[] = [];

  return {
    contexts,
    newContext: vi.fn(async (_opts?: Record<string, unknown>) => {
      const ctx = mockContext();
      contexts.push(ctx);
      return ctx;
    }),
  };
}

function mockContext() {
  const pages: ReturnType<typeof mockPage>[] = [];
  return {
    pages,
    newPage: vi.fn(async () => {
      const p = mockPage();
      pages.push(p);
      return p;
    }),
    close: vi.fn(async () => {}),
    storageState: vi.fn(),
  };
}

function mockPage() {
  return {
    url: vi.fn(() => 'http://localhost'),
    title: vi.fn(async () => 'Test'),
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from('fake')),
    evaluate: vi.fn(async () => null),
    mouse: { wheel: vi.fn(async () => {}) },
    locator: vi.fn(() => ({
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
    })),
  };
}

function successResult(overrides?: Partial<AgentResult>): AgentResult {
  return {
    success: true,
    result: 'done',
    turns: [],
    totalMs: 100,
    ...overrides,
  };
}

// We need to mock BrowserAgent since it requires real LLM calls.
// Mock the module so create() builds runners that return controlled results.
const mockRunFn = vi.fn<(scenario: Scenario) => Promise<AgentResult>>();

vi.mock('../src/runner.js', () => {
  // Vitest v4 requires `function` keyword for mock constructors
  const BrowserAgent = vi.fn(function (this: { run: typeof mockRunFn }) {
    this.run = mockRunFn;
  });
  return { BrowserAgent };
});

// Mock PlaywrightDriver since it requires a real Page
vi.mock('../src/drivers/playwright.js', () => {
  const PlaywrightDriver = vi.fn(function () {
    // empty — driver methods aren't called directly in these tests
  });
  return { PlaywrightDriver };
});

// ── Tests ──

describe('MultiActorSession', () => {
  let browser: ReturnType<typeof mockBrowser>;

  beforeEach(() => {
    browser = mockBrowser();
    mockRunFn.mockReset();
    mockRunFn.mockResolvedValue(successResult());
  });

  describe('create', () => {
    it('creates contexts and pages for each actor', async () => {
      const config: MultiActorSessionConfig = {
        actors: {
          admin: {},
          partner: {},
          user1: {},
        },
      };

      const session = await MultiActorSession.create(browser as never, config);

      expect(browser.newContext).toHaveBeenCalledTimes(3);
      expect(browser.contexts).toHaveLength(3);
      expect(session.actorNames).toEqual(['admin', 'partner', 'user1']);
      expect(session.allActors).toHaveLength(3);

      await session.close();
    });

    it('passes storageState to context options', async () => {
      const config: MultiActorSessionConfig = {
        actors: {
          admin: { storageState: '.auth/admin.json' },
        },
      };

      await MultiActorSession.create(browser as never, config);

      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({ storageState: '.auth/admin.json' }),
      );
    });

    it('passes contextOptions through to browser.newContext', async () => {
      const config: MultiActorSessionConfig = {
        actors: {
          admin: {
            contextOptions: { viewport: { width: 1920, height: 1080 }, locale: 'en-US' },
          },
        },
      };

      await MultiActorSession.create(browser as never, config);

      expect(browser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1920, height: 1080 },
          locale: 'en-US',
        }),
      );
    });

    it('calls setup hooks during creation', async () => {
      const setupFn = vi.fn(async () => {});

      const config: MultiActorSessionConfig = {
        actors: {
          admin: { setup: setupFn },
        },
      };

      await MultiActorSession.create(browser as never, config);

      expect(setupFn).toHaveBeenCalledTimes(1);
      // Setup receives the page
      expect(setupFn).toHaveBeenCalledWith(expect.objectContaining({ url: expect.any(Function) }));
    });

    it('merges shared agentConfig with per-actor overrides', async () => {
      const { BrowserAgent } = await import('../src/runner.js');
      vi.mocked(BrowserAgent).mockClear();

      const config: MultiActorSessionConfig = {
        agentConfig: { model: 'gpt-4o', vision: true, debug: false },
        actors: {
          admin: { agentConfig: { model: 'claude-sonnet-4-20250514', debug: true } },
          user: {},
        },
      };

      await MultiActorSession.create(browser as never, config);

      // BrowserAgent is called twice (once per actor)
      const calls = vi.mocked(BrowserAgent).mock.calls;
      expect(calls).toHaveLength(2);

      // admin: per-actor model + debug override shared config
      expect(calls[0][0].config).toEqual({
        model: 'claude-sonnet-4-20250514',
        vision: true,
        debug: true,
      });

      // user: inherits shared config as-is
      expect(calls[1][0].config).toEqual({
        model: 'gpt-4o',
        vision: true,
        debug: false,
      });
    });

    it('passes driverOptions to PlaywrightDriver', async () => {
      const { PlaywrightDriver } = await import('../src/drivers/playwright.js');
      vi.mocked(PlaywrightDriver).mockClear();

      const driverOpts = { timeout: 5000, captureScreenshots: false };

      await MultiActorSession.create(browser as never, {
        actors: { admin: { driverOptions: driverOpts } },
      });

      expect(vi.mocked(PlaywrightDriver)).toHaveBeenCalledWith(
        expect.anything(), // page
        driverOpts,
      );
    });

    it('passes projectStore to all BrowserAgents', async () => {
      const { BrowserAgent } = await import('../src/runner.js');
      vi.mocked(BrowserAgent).mockClear();

      const fakeStore = { getKnowledgePath: vi.fn(), getSelectorCachePath: vi.fn() };

      await MultiActorSession.create(browser as never, {
        actors: { admin: {}, user: {} },
        projectStore: fakeStore as never,
      });

      const calls = vi.mocked(BrowserAgent).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].projectStore).toBe(fakeStore);
      expect(calls[1][0].projectStore).toBe(fakeStore);
    });

    it('cleans up contexts if a setup hook throws', async () => {
      const failingSetup = vi.fn(async () => { throw new Error('login failed'); });

      await expect(
        MultiActorSession.create(browser as never, {
          actors: {
            admin: {},  // created successfully
            partner: { setup: failingSetup },  // throws during setup
          },
        }),
      ).rejects.toThrowError('login failed');

      // Both contexts should be closed (cleanup)
      for (const ctx of browser.contexts) {
        expect(ctx.close).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('actor()', () => {
    it('returns the correct actor by name', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, partner: {} },
      });

      const admin = session.actor('admin');
      expect(admin).toBeInstanceOf(Actor);
      expect(admin.name).toBe('admin');

      await session.close();
    });

    it('throws descriptive error on invalid actor name', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, partner: {} },
      });

      expect(() => session.actor('unknown')).toThrowError(
        'Actor "unknown" not found. Available actors: admin, partner',
      );

      await session.close();
    });
  });

  describe('Actor.run()', () => {
    it('delegates to BrowserAgent and accumulates results', async () => {
      const result1 = successResult({ result: 'first' });
      const result2 = successResult({ result: 'second' });
      mockRunFn.mockResolvedValueOnce(result1).mockResolvedValueOnce(result2);

      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      const admin = session.actor('admin');

      const r1 = await admin.run({ goal: 'Do first thing' });
      expect(r1).toBe(result1);
      expect(admin.results).toHaveLength(1);
      expect(admin.lastResult).toBe(result1);

      const r2 = await admin.run({ goal: 'Do second thing' });
      expect(r2).toBe(result2);
      expect(admin.results).toHaveLength(2);
      expect(admin.lastResult).toBe(result2);

      await session.close();
    });

    it('passes scenario through to runner', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      const scenario: Scenario = { goal: 'Create quest', startUrl: '/admin', maxTurns: 10 };
      await session.actor('admin').run(scenario);

      expect(mockRunFn).toHaveBeenCalledWith(scenario);

      await session.close();
    });
  });

  describe('parallel()', () => {
    it('runs multiple actors concurrently and returns Map of results', async () => {
      const adminResult = successResult({ result: 'admin done' });
      const userResult = successResult({ result: 'user done' });

      // Track call order to verify concurrency
      let callCount = 0;
      mockRunFn.mockImplementation(async () => {
        callCount++;
        const thisCall = callCount;
        // Simulate async work — both should start before either finishes
        await new Promise((r) => setTimeout(r, 10));
        return thisCall <= 1 ? adminResult : userResult;
      });

      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, user1: {} },
      });

      const results = await session.parallel(
        ['admin', { goal: 'Monitor' }],
        ['user1', { goal: 'Browse' }],
      );

      expect(results).toBeInstanceOf(Map);
      expect(results.size).toBe(2);
      expect(results.get('admin')).toBe(adminResult);
      expect(results.get('user1')).toBe(userResult);

      // Results also accumulated on actors
      expect(session.actor('admin').results).toHaveLength(1);
      expect(session.actor('user1').results).toHaveLength(1);

      await session.close();
    });

    it('throws on invalid actor name', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      await expect(
        session.parallel(['nonexistent', { goal: 'Fail' }]),
      ).rejects.toThrowError(/Actor "nonexistent" not found/);

      await session.close();
    });
  });

  describe('onTurn callback', () => {
    it('receives actor name and turn data', async () => {
      const turnCallback = vi.fn();

      // We need to capture the onTurn that was passed to BrowserAgent
      // and invoke it to verify the wrapping behavior
      const { BrowserAgent } = await import('../src/runner.js');
      let capturedOnTurn: ((turn: Turn) => void) | undefined;

      vi.mocked(BrowserAgent).mockImplementation(function (this: { run: typeof mockRunFn }, opts: { onTurn?: (turn: Turn) => void }) {
        capturedOnTurn = opts.onTurn;
        this.run = mockRunFn;
      } as never);

      await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
        onTurn: turnCallback,
      });

      // Simulate a turn callback from the runner
      const fakeTurn: Turn = {
        turn: 1,
        state: { url: 'http://localhost', title: 'Test', snapshot: '' },
        action: { action: 'click', selector: '@abc' },
        durationMs: 50,
      };

      expect(capturedOnTurn).toBeDefined();
      capturedOnTurn!(fakeTurn);

      expect(turnCallback).toHaveBeenCalledWith('admin', fakeTurn);
    });
  });

  describe('close()', () => {
    it('closes all browser contexts', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, partner: {}, user1: {} },
      });

      await session.close();

      for (const ctx of browser.contexts) {
        expect(ctx.close).toHaveBeenCalledTimes(1);
      }
    });

    it('is idempotent — second close is a no-op', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      await session.close();
      await session.close();

      expect(browser.contexts[0].close).toHaveBeenCalledTimes(1);
    });

    it('throws AggregateError if contexts fail to close', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, partner: {} },
      });

      browser.contexts[0].close.mockRejectedValue(new Error('context 0 stuck'));
      browser.contexts[1].close.mockRejectedValue(new Error('context 1 stuck'));

      await expect(session.close()).rejects.toThrowError(/Failed to close some actor contexts/);
    });
  });

  describe('results', () => {
    it('aggregates results across all actors', async () => {
      const r1 = successResult({ result: 'admin-1' });
      const r2 = successResult({ result: 'partner-1' });
      mockRunFn.mockResolvedValueOnce(r1).mockResolvedValueOnce(r2);

      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, partner: {} },
      });

      await session.actor('admin').run({ goal: 'A' });
      await session.actor('partner').run({ goal: 'B' });

      const results = session.results;
      expect(results.get('admin')).toEqual([r1]);
      expect(results.get('partner')).toEqual([r2]);

      await session.close();
    });
  });

  describe('Actor page/context/driver access', () => {
    it('exposes raw page, context, and driver for direct operations', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      const admin = session.actor('admin');

      expect(admin.page).toBeDefined();
      expect(admin.page.url).toBeDefined();
      expect(admin.context).toBeDefined();
      expect(admin.context.close).toBeDefined();
      expect(admin.driver).toBeDefined();

      await session.close();
    });
  });

  describe('parallel() partial failure', () => {
    it('rejects but still accumulates results on actors that succeeded', async () => {
      const adminResult = successResult({ result: 'admin done' });

      let resolveAdmin: () => void;
      const adminPromise = new Promise<void>((r) => { resolveAdmin = r; });

      mockRunFn.mockImplementation(async (scenario) => {
        if (scenario.goal === 'Monitor') {
          // Admin finishes first
          resolveAdmin!();
          return adminResult;
        }
        // User throws after admin finishes
        await adminPromise;
        throw new Error('Agent failed');
      });

      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {}, user1: {} },
      });

      await expect(
        session.parallel(
          ['admin', { goal: 'Monitor' }],
          ['user1', { goal: 'Browse' }],
        ),
      ).rejects.toThrowError('Agent failed');

      // Admin's result is still accessible
      expect(session.actor('admin').results).toHaveLength(1);
      expect(session.actor('admin').lastResult).toBe(adminResult);

      await session.close();
    });
  });

  describe('lastResult', () => {
    it('returns undefined when no runs have occurred', async () => {
      const session = await MultiActorSession.create(browser as never, {
        actors: { admin: {} },
      });

      expect(session.actor('admin').lastResult).toBeUndefined();

      await session.close();
    });
  });
});
