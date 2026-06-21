/**
 * Workflow Replay — contracts.
 *
 * Replay re-executes a previously-recorded successful {@link Trajectory} against
 * the live browser with ZERO per-action LLM calls. A normal run is ~97-98%
 * LLM-latency-bound (~10-13s per `brain.decide` round-trip); replaying a known
 * task collapses a ~40s / 3-call run into ~1-3s of pure browser I/O plus a
 * single goal-verification LLM call at the end.
 *
 * Where it slots in: replay is a SIBLING pre-loop path to the planner-first
 * path in `runner.ts`. The runner attempts replay first; on success it returns,
 * and on a self-heal abort it falls through to the normal per-action loop FROM
 * THE CURRENT PAGE STATE (same fall-through pattern the planner path already
 * uses). Replay never blindly claims success — even a fully-replayed run ends
 * with the existing `brain.verifyGoalCompletion` (one LLM call).
 *
 * Self-heal semantics (the safety net):
 *   A wrong replay is cheap. Each step is gated twice — by a pure pre-execution
 *   guard ({@link ReplayGuard}) and by post-execution effect verification — so a
 *   trajectory that no longer fits the live page ABORTS after at most a few fast
 *   browser actions and hands control to the agent. The final outcome is never
 *   worse than running the agent from scratch; the only cost of a bad replay is
 *   the handful of actions executed before the heal fired. Because of this, the
 *   guard deliberately gates on ACTION-PERFORMABILITY, not on exact snapshot
 *   identity: the page legitimately differs run-to-run (timestamps, session
 *   chrome, ad slots, list ordering), so a hard `snapshotHash` equality gate
 *   would heal on nearly every replay and defeat the purpose. `snapshotHash`
 *   drift is at most a secondary heuristic; the real question the guard answers
 *   is "can THIS action still be performed against the page in front of me?".
 *
 * This module is contracts only — no executor logic. The pure guard core
 * ({@link ReplayGuard}) is kept separate from the IO executor
 * ({@link ReplayController}) so the decision logic unit-tests without a browser.
 */

import type { Action } from '../../types/actions.js';
import type { PageState } from '../../types/page.js';
import type { Turn } from '../../types/turn.js';
import type { GoalVerification } from '../../types/result.js';
import type { Trajectory, TrajectoryStep } from '../../types/trajectory.js';
import type { Driver } from '../../drivers/types.js';
import type { EffectVerificationInput, EffectVerificationResult } from '../effect-verification.js';

/**
 * Strict goal-similarity bar for selecting a replay candidate. Far higher than
 * the 0.5 hint-injection threshold used by {@link TrajectoryStore.findBestMatch}:
 * an imperfect reference is fine to *show* the LLM as a hint, but replaying it
 * verbatim against the live page demands a near-exact task match.
 */
export const DEFAULT_REPLAY_SIMILARITY_THRESHOLD = 0.85;

/**
 * A single replayable step. Reuses {@link TrajectoryStep} (url + action +
 * snapshotHash + verified + the OPTIONAL persisted `expectedEffect`).
 *
 * `expectedEffect` now rides on {@link TrajectoryStep} and is persisted by
 * `save()` from `Turn.expectedEffect` (older trajectories written before that
 * change simply lack the field). When present, the controller asserts it
 * against the live page via the injected {@link ReplayContext.verifyEffect}
 * (the runner's own `verifyExpectedEffect`) — this is the real second gate
 * behind the "gated twice" safety thesis. When ABSENT, the controller falls
 * back to a generic "the action executed without error" check and records
 * whether the page changed for diagnostics only; the guard pre-check plus the
 * execute-success gate plus the final goal verification remain the safety net.
 */
export interface ReplayStep extends TrajectoryStep {
  /** Effect to assert after executing this step (see effect-verification). */
  expectedEffect?: string;
}

/**
 * A matched replay candidate plus the metadata that justified selecting it.
 * Produced from a strict {@link ReplayCandidateSource.findReplayCandidate} hit.
 */
export interface ReplayPlan {
  /** The full source trajectory the steps came from. */
  trajectory: Trajectory;
  /** Concrete, executable browser steps (complete/abort already filtered at save time). */
  steps: ReplayStep[];
  /** Jaccard goal similarity between the live goal and the trajectory's goal (>= threshold). */
  goalSimilarity: number;
  /** Normalized origin the trajectory was scoped to, when known. */
  origin?: string;
}

/**
 * The minimal live observation the pure guard reads: current URL + snapshot
 * text. Deliberately narrower than {@link PageState} (no screenshot/diff) so
 * guard unit tests can pass plain literals with no browser.
 */
export type ReplayObservation = Pick<PageState, 'url' | 'snapshot'>;

/**
 * Result of the pure pre-execution guard for one step.
 *
 * Discriminated so an `abort` always carries a human-readable `reason` (the heal
 * path must be explicit and logged) while `proceed` never needs one.
 */
export type StepGuardResult =
  | { decision: 'proceed' }
  | { decision: 'abort'; reason: string };

/**
 * Pure decision core: given a recorded step and the current observation, decide
 * whether the step can still be replayed. NO IO — it never touches the driver.
 *
 * It gates on action-performability, not snapshot identity:
 *   - the action's target must be addressable in the current snapshot (e.g. an
 *     `@ref` selector's `[ref=...]` token is still present), and
 *   - the URL/origin must be consistent with `step.url`.
 * For selectors it cannot statically resolve against snapshot text (CSS, text=,
 * role=), it returns `proceed` and defers to execution + effect verification —
 * the guard is a cheap pre-filter, not the hard gate. See the module-level
 * self-heal note for why exact `snapshotHash` equality is intentionally NOT a
 * gate.
 */
export interface ReplayGuard {
  check(step: ReplayStep, current: ReplayObservation): StepGuardResult;
}

/**
 * Final goal verification (one LLM call). Matches `brain.verifyGoalCompletion`
 * so the controller can depend on the capability without importing the brain.
 */
export type GoalVerifier = (
  state: PageState,
  goal: string,
  claimedResult: string,
) => Promise<GoalVerification>;

/**
 * Observable lifecycle of a replay attempt. Every heal/abort is surfaced so the
 * decision is never silent. Wired to the runner's event bus in the executor.
 */
export type ReplayEvent =
  | { type: 'replay-started'; trajectoryId: string; totalSteps: number; goalSimilarity: number }
  | { type: 'replay-step'; index: number; totalSteps: number; action: Action['action'] }
  | { type: 'replay-guard-abort'; index: number; reason: string }
  | { type: 'replay-effect-failed'; index: number; reason: string }
  | { type: 'replay-healed'; completedSteps: number; totalSteps: number; reason: string }
  | { type: 'replay-completed'; completedSteps: number; achieved: boolean };

/**
 * Everything the IO executor needs, injected so the controller stays decoupled
 * from the concrete runner/brain wiring.
 */
export interface ReplayContext {
  /** The live goal being pursued. */
  goal: string;
  /** Live browser driver (observe + execute). */
  driver: Driver;
  /** Pure step guard. */
  guard: ReplayGuard;
  /** Final goal-completion verifier (the single permitted LLM call). */
  verifyGoal: GoalVerifier;
  /**
   * Per-step effect verifier — the runner injects its own pure
   * `verifyExpectedEffect` (src/runner/effect-verification.ts). Typed against
   * that module so the controller is FORCED to reuse the runner's verifier
   * rather than hand-rolling a weaker per-step check, and so the second gate
   * stays pure + unit-testable. Only consulted when a step carries a persisted
   * `expectedEffect`. NO LLM call — this is deterministic string/state diffing.
   */
  verifyEffect: (input: EffectVerificationInput) => EffectVerificationResult;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Verbose logging passthrough. */
  debug?: boolean;
  /** Optional structured event sink (runner bridges this to its TurnEventBus). */
  onEvent?: (event: ReplayEvent) => void;
}

/** Discriminant for {@link ReplayOutcome}. */
export type ReplayOutcomeKind = 'completed' | 'healed' | 'no-candidate';

/** Fields common to every replay outcome. */
interface ReplayOutcomeBase {
  /**
   * Steps that replayed cleanly (guard proceed + execute + effect ok) before
   * this outcome. EXCLUDES the step that aborted on `healed`. Diagnostic /
   * event payload only — `turns.length` (below) is the authoritative count the
   * runner uses to advance its loop index, mirroring the planner path's
   * `cumulativeTurnsConsumed` semantics. `turns` may therefore contain one more
   * entry than `completedSteps` when a step executed but its effect failed.
   */
  completedSteps: number;
  /** Total steps in the plan (0 when there was no candidate). */
  totalSteps: number;
  /** LLM calls replay itself spent — 1 on `completed` (final verify), 0 otherwise. */
  llmCallsUsed: number;
  /**
   * Replay steps recorded as turns, for merging into the unified run timeline.
   * AUTHORITATIVE for resume accounting: because replay is the FIRST pre-loop
   * path it appends to an empty `turns` array, numbering its turns 1..N, and
   * the runner offsets the per-action loop start by `turns.length` so a
   * fall-through never re-executes a recorded step.
   */
  turns: Turn[];
}

/**
 * The result of a replay attempt.
 *
 * - `completed`: all steps replayed and the final goal verification ran. Carries
 *   the `goalVerification`, the `finalResult` string, and `lastState`.
 *   `achieved` may still be false — replay surfaces the verdict honestly rather
 *   than fabricating success. REQUIRED runner behavior: only
 *   `completed && goalVerification.achieved === true` is terminal (build the
 *   success result and return). `completed && achieved === false` MUST fall
 *   through to the per-action loop FROM `lastState`, exactly like `healed` —
 *   never return a confident failure off the back of a replay, which would be
 *   strictly worse than running the agent from scratch.
 * - `healed`: a guard/execute/effect gate aborted mid-replay. Carries `reason`
 *   and `lastState` so the runner continues its per-action loop from here.
 * - `no-candidate`: no strict match was found (or replay was disabled); the
 *   runner proceeds to its normal path untouched (no `lastState`, no turns).
 */
export type ReplayOutcome =
  | (ReplayOutcomeBase & {
      kind: 'completed';
      lastState: PageState;
      goalVerification: GoalVerification;
      finalResult: string;
    })
  | (ReplayOutcomeBase & {
      kind: 'healed';
      lastState: PageState;
      reason: string;
    })
  | (ReplayOutcomeBase & {
      kind: 'no-candidate';
      reason: string;
    });

/**
 * IO executor: drives the driver + guard through a {@link ReplayPlan}.
 *
 * For each step: observe → {@link ReplayGuard.check} (abort → heal) →
 * `driver.execute` (error → heal) → verify expected effect (fail → heal). After
 * all steps replay, run {@link ReplayContext.verifyGoal} once. Implementations
 * MUST NOT make per-action LLM calls; the final goal verification is the only
 * permitted model round-trip.
 */
export interface ReplayController {
  replay(plan: ReplayPlan, ctx: ReplayContext): Promise<ReplayOutcome>;
}

/** Options for the strict replay-candidate lookup. */
export interface ReplayMatchOptions {
  /**
   * Origin to scope the lookup to. When supplied, only trajectories whose
   * normalized origin matches exactly are eligible. The replay WIRING always
   * supplies it from the live run's start URL (`scenario.startUrl`), and the
   * runner only enters the replay path when an origin resolves — verbatim
   * browser actions must never be selected cross-origin on lexical goal overlap
   * alone. Left optional on the type so the store method stays general, but a
   * production replay call without an origin is a wiring bug.
   */
  origin?: string;
  /** Minimum goal similarity to qualify. Defaults to {@link DEFAULT_REPLAY_SIMILARITY_THRESHOLD}. */
  minSimilarity?: number;
}

/**
 * A strict replay-candidate hit: the matched trajectory plus the score and
 * origin that justified it. Returned (rather than a bare {@link Trajectory}) so
 * the plan-builder can populate {@link ReplayPlan.goalSimilarity} and the
 * `replay-started` event WITHOUT re-implementing the store's private Jaccard —
 * the score that passed the gate is the score the plan reports.
 */
export interface ReplayCandidate {
  trajectory: Trajectory;
  /** Raw Jaccard goal similarity that cleared the threshold. */
  similarity: number;
  /** Normalized origin the trajectory was scoped to, when known. */
  origin?: string;
}

/**
 * The strict-match lookup replay depends on. Separate from `findBestMatch`
 * (which keeps its 0.5 hint-injection threshold): a replay candidate requires
 * `success === true`, a non-empty step list, an exact origin match when an
 * origin is supplied, and goal similarity >= the strict threshold.
 * {@link TrajectoryStore} satisfies this interface.
 */
export interface ReplayCandidateSource {
  findReplayCandidate(goal: string, options?: ReplayMatchOptions): ReplayCandidate | null;
}

/**
 * Runtime config for replay. OPT-IN (`enabled` defaults to false / `--replay`)
 * per the repo's experiment discipline until measured non-regressive.
 */
export interface ReplayConfig {
  /** Master switch. Default behavior is byte-identical when false. */
  enabled: boolean;
  /** Override the strict similarity bar. Defaults to {@link DEFAULT_REPLAY_SIMILARITY_THRESHOLD}. */
  minSimilarity?: number;
}
