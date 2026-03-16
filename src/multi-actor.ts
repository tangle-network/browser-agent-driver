/**
 * Multi-Actor Session — coordinated multi-user browser testing
 *
 * Each actor gets an isolated BrowserContext (separate cookies, localStorage,
 * auth state) while sharing the same Browser instance. Consumers orchestrate
 * with standard async/await for sequential flows and Promise.all() for parallel.
 *
 * ```typescript
 * const session = await MultiActorSession.create(browser, {
 *   actors: {
 *     admin:   { storageState: '.auth/admin.json' },
 *     partner: { storageState: '.auth/partner.json' },
 *     user1:   {},
 *   },
 *   agentConfig: { model: 'gpt-4o', vision: true },
 * });
 *
 * await session.actor('admin').run({ goal: 'Create quest', startUrl: '/admin' });
 * await session.actor('partner').run({ goal: 'Approve quest' });
 *
 * await session.parallel(
 *   ['user1', { goal: 'Start quest' }],
 *   ['admin', { goal: 'Monitor dashboard' }],
 * );
 *
 * await session.close();
 * ```
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { PlaywrightDriver } from './drivers/playwright.js';
import type { PlaywrightDriverOptions } from './drivers/playwright.js';
import { BrowserAgent } from './runner.js';
import type { BrowserAgentOptions } from './runner.js';
import type { Scenario, AgentConfig, AgentResult, Turn } from './types.js';
import type { ProjectStore } from './memory/project-store.js';

// ── Types ──

export interface ActorConfig {
  /** Playwright storage state for pre-authenticated sessions */
  storageState?: string | BrowserContextOptions['storageState'];
  /** Setup hook called after context+page creation (e.g., manual login) */
  setup?: (page: Page) => Promise<void>;
  /** Agent config overrides for this actor (merged on top of shared config) */
  agentConfig?: Partial<AgentConfig>;
  /** Playwright context options (viewport, locale, etc.) */
  contextOptions?: BrowserContextOptions;
  /** Playwright driver options (timeout, screenshots) */
  driverOptions?: PlaywrightDriverOptions;
}

export interface MultiActorSessionConfig {
  /** Named actors keyed by role/identity */
  actors: Record<string, ActorConfig>;
  /** Shared agent config applied to all actors (per-actor overrides win) */
  agentConfig?: AgentConfig;
  /** Turn callback receives actor name + turn for cross-actor logging */
  onTurn?: (actorName: string, turn: Turn) => void;
  /** Project memory store shared across actors */
  projectStore?: ProjectStore;
}

// ── Actor ──

export class Actor {
  private _results: AgentResult[] = [];

  constructor(
    readonly name: string,
    private _context: BrowserContext,
    private _page: Page,
    private _driver: PlaywrightDriver,
    private _runner: BrowserAgent,
  ) {}

  /** Run a scenario with this actor's agent. Results accumulate across calls. */
  async run(scenario: Scenario): Promise<AgentResult> {
    const result = await this._runner.run(scenario);
    this._results.push(result);
    return result;
  }

  /** Raw Playwright page for direct operations / assertions */
  get page(): Page {
    return this._page;
  }

  /** BrowserContext for cookie/storage inspection */
  get context(): BrowserContext {
    return this._context;
  }

  /** PlaywrightDriver for low-level driver access */
  get driver(): PlaywrightDriver {
    return this._driver;
  }

  /** All results from this actor's runs */
  get results(): readonly AgentResult[] {
    return this._results;
  }

  /** Most recent result, or undefined if no runs yet */
  get lastResult(): AgentResult | undefined {
    return this._results[this._results.length - 1];
  }
}

// ── MultiActorSession ──

export class MultiActorSession {
  private _actors: Map<string, Actor>;
  private _closed = false;

  private constructor(actors: Map<string, Actor>) {
    this._actors = actors;
  }

  /**
   * Create a session with isolated browser contexts per actor.
   *
   * 1. Creates BrowserContext + Page + PlaywrightDriver + BrowserAgent per actor
   * 2. Calls setup() hooks if provided
   * 3. Returns session ready for orchestration
   */
  static async create(
    browser: Browser,
    config: MultiActorSessionConfig,
  ): Promise<MultiActorSession> {
    const actors = new Map<string, Actor>();
    const createdContexts: BrowserContext[] = [];

    try {
      for (const [name, actorCfg] of Object.entries(config.actors)) {
        // Merge shared + per-actor agent config
        const mergedAgentConfig: AgentConfig = {
          ...config.agentConfig,
          ...actorCfg.agentConfig,
        };

        // Build context options with storageState
        const contextOptions: BrowserContextOptions = {
          ...actorCfg.contextOptions,
        };
        if (actorCfg.storageState) {
          contextOptions.storageState = actorCfg.storageState;
        }

        const context = await browser.newContext(contextOptions);
        createdContexts.push(context);
        const page = await context.newPage();
        const driver = new PlaywrightDriver(page, actorCfg.driverOptions);

        // Wire onTurn to prefix with actor name
        const onTurn = config.onTurn
          ? (turn: Turn) => config.onTurn!(name, turn)
          : undefined;

        const runnerOpts: BrowserAgentOptions = {
          driver,
          config: mergedAgentConfig,
          onTurn,
          projectStore: config.projectStore,
        };

        const runner = new BrowserAgent(runnerOpts);

        // Run actor setup hook (e.g., manual login flow)
        if (actorCfg.setup) {
          await actorCfg.setup(page);
        }

        actors.set(name, new Actor(name, context, page, driver, runner));
      }
    } catch (err) {
      // Clean up already-created contexts on partial failure
      for (const ctx of createdContexts) {
        await ctx.close().catch(() => {});
      }
      throw err;
    }

    return new MultiActorSession(actors);
  }

  /** Get an actor by name. Throws with available names on miss. */
  actor(name: string): Actor {
    const a = this._actors.get(name);
    if (!a) {
      const available = [...this._actors.keys()].join(', ');
      throw new Error(
        `Actor "${name}" not found. Available actors: ${available}`,
      );
    }
    return a;
  }

  /**
   * Run multiple actors in parallel. Returns a Map of actor name → result.
   *
   * If any actor fails (throws), all results collected so far are still
   * available via each actor's `.results` array.
   */
  async parallel(
    ...tasks: [actorName: string, scenario: Scenario][]
  ): Promise<Map<string, AgentResult>> {
    const entries = await Promise.all(
      tasks.map(async ([name, scenario]) => {
        const result = await this.actor(name).run(scenario);
        return [name, result] as const;
      }),
    );
    return new Map(entries);
  }

  /** Close all browser contexts. Pages close with their contexts. */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    const errors: Error[] = [];
    for (const actor of this._actors.values()) {
      try {
        await actor.context.close();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close some actor contexts');
    }
  }

  /** All results across all actors, keyed by actor name */
  get results(): Map<string, readonly AgentResult[]> {
    const map = new Map<string, readonly AgentResult[]>();
    for (const [name, actor] of this._actors) {
      map.set(name, actor.results);
    }
    return map;
  }

  /** All actors for iteration */
  get allActors(): Actor[] {
    return [...this._actors.values()];
  }

  /** Actor names */
  get actorNames(): string[] {
    return [...this._actors.keys()];
  }
}
