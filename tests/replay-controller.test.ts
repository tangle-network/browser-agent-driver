import { describe, expect, it } from 'vitest';
import { SelfHealingReplayController, createReplayController } from '../src/runner/replay/controller.js';
import { createReplayGuard } from '../src/runner/replay/guard.js';
import type {
  ReplayContext,
  ReplayPlan,
  ReplayStep,
} from '../src/runner/replay/contracts.js';
import type { Driver, ActionResult } from '../src/drivers/types.js';
import type { Action, GoalVerification, PageState } from '../src/types.js';

const BOTH_REFS = ['- button "Alpha" [ref=aaa]', '- button "Beta" [ref=bbb]'].join('\n');
const ONLY_ALPHA = '- button "Alpha" [ref=aaa]';
const URL = 'https://example.com/app';

function mkState(snapshot: string, url = URL, title = 'App'): PageState {
  return { url, title, snapshot };
}

function mkStep(action: Action, extra: Partial<ReplayStep> = {}): ReplayStep {
  return { url: URL, action, snapshotHash: '0', ...extra };
}

function mkPlan(steps: ReplayStep[]): ReplayPlan {
  return {
    trajectory: {
      id: 'traj_test',
      goal: 'do the thing',
      steps,
      success: true,
      durationMs: 100,
      model: 'test',
      timestamp: new Date().toISOString(),
    },
    steps,
    goalSimilarity: 0.92,
    origin: 'https://example.com',
  };
}

/** Minimal in-memory Driver: observe() walks a queue, execute() is scripted. */
class FakeDriver {
  executed: Action[] = [];
  observeCalls = 0;
  private queue: PageState[];
  private execResults: ActionResult[];

  constructor(states: PageState[], execResults: ActionResult[] = []) {
    this.queue = [...states];
    this.execResults = [...execResults];
  }

  async observe(): Promise<PageState> {
    this.observeCalls++;
    // Shift while more than one remains; the last entry sticks for subsequent calls.
    return this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
  }

  async execute(action: Action): Promise<ActionResult> {
    this.executed.push(action);
    return this.execResults.length > 0 ? this.execResults.shift()! : { success: true };
  }

  getUrl(): string {
    return this.queue[0]?.url ?? URL;
  }
}

interface CtxSpies {
  verifyGoalCalls: number;
  verifyEffectCalls: number;
}

function makeCtx(
  driver: FakeDriver,
  opts: { goalAchieved?: boolean; effectVerified?: boolean; effectReason?: string } = {},
): { ctx: ReplayContext; spies: CtxSpies } {
  const spies: CtxSpies = { verifyGoalCalls: 0, verifyEffectCalls: 0 };
  const goalVerification: GoalVerification = {
    achieved: opts.goalAchieved ?? true,
    confidence: 0.9,
    evidence: ['fake'],
    missing: [],
  };
  const ctx: ReplayContext = {
    goal: 'do the thing',
    driver: driver as unknown as Driver,
    guard: createReplayGuard(),
    verifyGoal: async () => {
      spies.verifyGoalCalls++;
      return goalVerification;
    },
    verifyEffect: () => {
      spies.verifyEffectCalls++;
      return opts.effectVerified === false
        ? { verified: false, reason: opts.effectReason ?? 'effect not observed' }
        : { verified: true };
    },
  };
  return { ctx, spies };
}

describe('SelfHealingReplayController', () => {
  it('replays every step and runs ONE goal verification when all guards pass', async () => {
    const driver = new FakeDriver([mkState(BOTH_REFS)]);
    const { ctx, spies } = makeCtx(driver, { goalAchieved: true });
    const plan = mkPlan([
      mkStep({ action: 'click', selector: '@aaa' }),
      mkStep({ action: 'click', selector: '@bbb' }),
    ]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('completed');
    expect(outcome.completedSteps).toBe(2);
    expect(outcome.totalSteps).toBe(2);
    expect(outcome.turns).toHaveLength(2);
    expect(outcome.llmCallsUsed).toBe(1);
    expect(driver.executed.map((a) => a.action)).toEqual(['click', 'click']);
    expect(spies.verifyGoalCalls).toBe(1);
    expect(spies.verifyEffectCalls).toBe(0); // no expectedEffect on the steps
    // Turns are numbered from 1 for front-of-timeline merging.
    expect(outcome.turns.map((t) => t.turn)).toEqual([1, 2]);
    if (outcome.kind === 'completed') {
      expect(outcome.goalVerification.achieved).toBe(true);
      expect(outcome.finalResult).toContain('Replayed 2 recorded step');
    }
  });

  it('surfaces an honest verdict: completed but achieved=false when verify rejects', async () => {
    const driver = new FakeDriver([mkState(BOTH_REFS)]);
    const { ctx, spies } = makeCtx(driver, { goalAchieved: false });
    const plan = mkPlan([mkStep({ action: 'click', selector: '@aaa' })]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('completed');
    expect(spies.verifyGoalCalls).toBe(1);
    if (outcome.kind === 'completed') {
      expect(outcome.goalVerification.achieved).toBe(false);
    }
  });

  it('self-heals at step k when a later step\'s @ref has vanished', async () => {
    // step1 sees both refs; step2's pre-observe is missing [ref=bbb].
    const driver = new FakeDriver([
      mkState(BOTH_REFS), // step1 pre
      mkState(BOTH_REFS), // step1 post
      mkState(ONLY_ALPHA), // step2 pre -> guard abort
    ]);
    const { ctx, spies } = makeCtx(driver);
    const plan = mkPlan([
      mkStep({ action: 'click', selector: '@aaa' }),
      mkStep({ action: 'click', selector: '@bbb' }),
    ]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('healed');
    expect(outcome.completedSteps).toBe(1);
    expect(outcome.turns).toHaveLength(1);
    expect(outcome.llmCallsUsed).toBe(0);
    expect(driver.executed).toHaveLength(1); // only step1 executed
    expect(spies.verifyGoalCalls).toBe(0); // no LLM call on heal
    if (outcome.kind === 'healed') {
      expect(outcome.reason).toContain('@bbb');
      expect(outcome.lastState.snapshot).toBe(ONLY_ALPHA);
    }
  });

  it('self-heals when an action execution fails', async () => {
    const driver = new FakeDriver(
      [mkState(BOTH_REFS)],
      [{ success: false, error: 'click intercepted' }],
    );
    const { ctx, spies } = makeCtx(driver);
    const plan = mkPlan([
      mkStep({ action: 'click', selector: '@aaa' }),
      mkStep({ action: 'click', selector: '@bbb' }),
    ]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('healed');
    expect(outcome.completedSteps).toBe(0);
    expect(outcome.turns).toHaveLength(1); // the errored attempt is recorded
    expect(spies.verifyGoalCalls).toBe(0);
    if (outcome.kind === 'healed') {
      expect(outcome.reason).toContain('click intercepted');
      expect(outcome.turns[0].error).toContain('click intercepted');
    }
  });

  it('self-heals when a persisted expectedEffect is not observed', async () => {
    const driver = new FakeDriver([mkState(BOTH_REFS)]);
    const { ctx, spies } = makeCtx(driver, { effectVerified: false, effectReason: 'no new content' });
    const plan = mkPlan([
      mkStep({ action: 'click', selector: '@aaa' }, { expectedEffect: 'a results panel should appear' }),
    ]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('healed');
    expect(outcome.completedSteps).toBe(0);
    expect(outcome.turns).toHaveLength(1);
    expect(spies.verifyEffectCalls).toBe(1); // the injected runner verifier was consulted
    expect(spies.verifyGoalCalls).toBe(0);
    if (outcome.kind === 'healed') {
      expect(outcome.turns[0].verified).toBe(false);
      expect(outcome.turns[0].verificationFailure).toContain('no new content');
    }
  });

  it('proceeds past a step whose persisted expectedEffect IS observed', async () => {
    const driver = new FakeDriver([mkState(BOTH_REFS)]);
    const { ctx, spies } = makeCtx(driver, { effectVerified: true, goalAchieved: true });
    const plan = mkPlan([
      mkStep({ action: 'click', selector: '@aaa' }, { expectedEffect: 'panel appears' }),
    ]);

    const outcome = await createReplayController().replay(plan, ctx);

    expect(outcome.kind).toBe('completed');
    expect(spies.verifyEffectCalls).toBe(1);
    expect(spies.verifyGoalCalls).toBe(1);
  });

  it('heals immediately (no LLM call) on an empty plan', async () => {
    const driver = new FakeDriver([mkState(BOTH_REFS)]);
    const { ctx, spies } = makeCtx(driver);
    const controller = new SelfHealingReplayController();

    const outcome = await controller.replay(mkPlan([]), ctx);

    expect(outcome.kind).toBe('healed');
    expect(outcome.completedSteps).toBe(0);
    expect(outcome.llmCallsUsed).toBe(0);
    expect(spies.verifyGoalCalls).toBe(0);
  });
});
