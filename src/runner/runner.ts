/**
 * Agent Runner — the main loop with verification, stuck detection, and recovery
 *
 * Loop: observe -> decide -> execute -> verify -> recover (if needed)
 *
 * Key improvements over simple observe-decide-execute:
 * - Post-action verification: checks expectedEffect after each action
 * - Stuck detection: tracks URL + snapshot hash across turns
 * - Recovery strategies: auto-triggered on failure patterns
 * - Plan tracking: detects when the agent repeats the same step
 */

import { Brain } from '../brain/index.js';
import type { Driver } from '../drivers/types.js';
import type { Scenario, AgentConfig, AgentResult, Turn, PageState, SupervisorConfig, Action, Plan } from '../types.js';
import { analyzeRecovery, detectPersistentTerminalBlocker, detectTerminalBlocker } from '../recovery.js';
import { solveCaptcha, canAttemptSolve } from '../captcha.js';
import { StaleRefError, AriaSnapshotHelper } from '../drivers/snapshot.js';
import { verifyPreview } from '../preview.js';
import type { ProjectStore } from '../memory/project-store.js';
import { AppKnowledge } from '../memory/knowledge.js';
import { SelectorCache } from '../memory/selectors.js';
import { detectSupervisorSignal, formatSupervisorSignal } from '../supervisor/policy.js';
import { requestSupervisorDirective } from '../supervisor/critic.js';
import { shouldAcceptFirstPartyBoundaryCompletion } from '../domain-policy.js';
import { deriveWasteMetrics } from '../run-metrics.js';
import { RunState, DEFAULT_TOKEN_BUDGET } from '../run-state.js';
import { ContextBudget } from '../context-budget.js';
import { runOverridePipeline } from '../override-pipeline.js';
import type { OverrideContext } from '../override-pipeline.js';

import { withRetry, findElementForRef, safeHostname, pushGoalVerificationEvidence } from './utils.js';
import { runExtractWithIndex, formatExtractWithIndexResult } from '../drivers/extract-with-index.js';
import { buildSearchResultsGuidance, buildVisibleLinkRecommendation, getVisibleLinkRecommendation, getRankedVisibleLinkCandidates, rankSearchCandidates } from './search-guidance.js';
import { buildGoalVerificationClaim, collectSearchWorkflowEvidence, shouldAcceptSearchWorkflowCompletion, shouldAcceptScriptBackedCompletion, detectCompletionContentTypeMismatch } from './goal-verification.js';
import { verifyExpectedEffect } from './effect-verification.js';
import { detectAiTanglePartnerTemplateVisibleState, detectAiTangleVerifiedOutputState, shouldEscalateVision } from './page-analysis.js';
import { shouldUseVisibleLinkScout, shouldUseVisibleLinkScoutPage, shouldUseBoundedBranchExplorer, inspectBranchPreview, scoreBranchPreview } from './scout.js';
import type { BranchPreview } from './scout.js';
import { buildOverrideProducers, buildScoutLinkRecommendationText, buildBranchLinkRecommendationText } from './overrides.js';

import type { Session } from '../memory/knowledge.js';
import { RunRegistry } from '../memory/run-registry.js';
import { TurnEventBus, ensureBus } from './events.js';
import { DecisionCache } from './decision-cache.js';
import { matchDeterministicPattern } from './deterministic-patterns.js';
import type { ResolvedExtensions } from '../extensions/types.js';

/**
 * Gen 6.1: detect that the agent is filling a multi-field form one input at
 * a time and inject a hint that demands a `fill` batch on the next turn.
 *
 * Trigger conditions (all must hold):
 *   1. The agent's most recent action was a single-step `type` on the
 *      current URL
 *   2. The current snapshot has 2+ unused fillable refs (textbox /
 *      searchbox / combobox) that the agent hasn't typed into yet
 *   3. We haven't already injected this hint in the last turn (to avoid
 *      hint loops if the agent ignores it)
 *
 * Why threshold of 1 type + 2 unused (not 3 consecutive types):
 *   Multi-step forms often have 2 fields per step before the user clicks
 *   "Next". Waiting for 3 consecutive types means the detector never fires
 *   on a typical 2-field-per-step form. Firing on the FIRST type action
 *   when the form clearly has more fields catches every multi-field form
 *   the moment the agent starts on it.
 *
 * The hint is high-priority (100) so it survives ctxBudget truncation, and
 * it explicitly lists the unused @refs from the current snapshot so the LLM
 * doesn't have to guess. The injection is gated by BAD_BATCH_HINT=0 for
 * rollback.
 */
export function detectBatchFillOpportunity(turns: Turn[], state: PageState): string | null {
  if (turns.length === 0) return null
  const lastTurn = turns[turns.length - 1]

  // Last action must be a single-step type on the current URL
  if (lastTurn.action.action !== 'type') return null
  if (lastTurn.state.url !== state.url) return null

  // Collect the @refs the agent has typed into across the ENTIRE run on
  // the same URL. The detector should never ask the agent to re-fill a
  // field it already filled, even if the earlier fill happened many
  // turns ago.
  const usedRefs = new Set<string>()
  for (const t of turns) {
    if (t.state.url !== state.url) continue
    const a = t.action
    if (a.action === 'type' && 'selector' in a && typeof a.selector === 'string') {
      usedRefs.add(a.selector)
    }
    if (a.action === 'fill') {
      for (const k of Object.keys(a.fields ?? {})) usedRefs.add(k)
      for (const k of Object.keys(a.selects ?? {})) usedRefs.add(k)
      for (const k of a.checks ?? []) usedRefs.add(k)
    }
  }

  // Find unused fillable refs in the current snapshot. We look for textbox,
  // searchbox, combobox, and spinbutton roles — anything that takes text.
  // Snapshot lines look like: `  - textbox "First name" [ref=t1f2a]`
  const unusedRefs: Array<{ ref: string; name: string; role: string }> = []
  for (const line of state.snapshot.split('\n')) {
    const match = line.match(/\b(textbox|searchbox|combobox|spinbutton)\b[^"]*"([^"]*)"[^[]*\[ref=([^\]]+)\]/i)
    if (!match) continue
    const role = match[1].toLowerCase()
    const name = match[2]
    const ref = `@${match[3]}`
    if (usedRefs.has(ref)) continue
    unusedRefs.push({ ref, name, role })
  }

  // Need at least 2 unused fields to make batching worthwhile
  if (unusedRefs.length < 2) return null

  const refList = unusedRefs
    .slice(0, 12) // cap so we don't explode the prompt
    .map((u) => `  - ${u.ref} (${u.role}: "${u.name}")`)
    .join('\n')

  return `\n[BATCH FILL REQUIRED]\nYou just typed into a single field, but ${unusedRefs.length} more fillable fields are visible on this same form. STOP. Your NEXT action MUST be a \`fill\` action that batches ALL remaining unused fields on this page in one turn. Do not emit another single-step \`type\` — emit \`fill\` with multiple entries.\n\nUnused fillable @refs from the current snapshot (use these in your \`fill.fields\` map):\n${refList}\n\nExample:\n{\"action\":\"fill\",\"fields\":{\"${unusedRefs[0].ref}\":\"value1\",\"${unusedRefs[1].ref}\":\"value2\"}}\n`
}

/** Build a structured session record from a completed run */
function buildSession(scenario: Scenario, result: AgentResult): Session {
  const lastTurn = result.turns[result.turns.length - 1]
  return {
    id: scenario.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    goal: scenario.goal,
    outcome: result.result || result.reason || (result.success ? 'Goal achieved' : 'Failed'),
    success: result.success,
    finalUrl: lastTurn?.state?.url || scenario.startUrl || '',
    timestamp: new Date().toISOString(),
    turnsUsed: result.turns.length,
    durationMs: result.totalMs,
  }
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MICRO_PLAN_ACTIONS = 2;
// Gen 18: clickAt/typeAt added so vision-mode can emit multi-action turns
// Gen 23: clickLabel/typeLabel for SoM-based actions
const SAFE_MICRO_ACTIONS = new Set<Action['action']>(['click', 'type', 'press', 'hover', 'select', 'scroll', 'wait', 'clickAt', 'typeAt', 'clickLabel', 'typeLabel']);
const DEFAULT_SUPERVISOR: Required<Pick<SupervisorConfig, 'enabled' | 'useVision' | 'minTurnsBeforeInvoke' | 'cooldownTurns' | 'maxInterventions' | 'hardStallWindow'>> = {
  enabled: true,
  useVision: true,
  minTurnsBeforeInvoke: 5,
  cooldownTurns: 3,
  maxInterventions: 2,
  hardStallWindow: 4,
};

const DEFI_BRAIN_CONTEXT =
  '\nWALLET/DeFi MODE ACTIVE — crypto app patterns:\n' +
  '- PERSISTENT WIDGETS: Many DeFi apps have always-on support/chat widgets (bottom-right) that show as alertdialog. These CANNOT be dismissed. Ignore them and interact with the page directly.\n' +
  '- WALLET CONNECTION: Look for "Connect Wallet" button, select MetaMask. The wallet extension handles the approval popup automatically.\n' +
  '- TOKEN SELECTION: If you need to change a token, click the token selector button (usually shows token symbol/icon), search for the token name, and select it from the dropdown.\n' +
  '- TRANSACTION FLOW: Enter amount → wait for quote/estimate to load → click action button (Swap/Supply/etc.) → review dialog appears → stop before confirming in MetaMask.\n' +
  '- LOADING STATES: DeFi apps make many RPC calls. Wait for balances and quotes to appear before clicking action buttons. If a button says "Enter amount" or is disabled, the app is still loading.\n' +
  '- NATIVE ETH: Prefer native ETH over wrapped tokens (WETH) when possible — avoids ERC-20 spending approval steps.\n' +
  '- NETWORK SELECTOR: Do NOT change the network/chain. If a network dropdown opens accidentally, close it immediately.\n' +
  '- COOKIE BANNERS: Dismiss immediately via Escape or Reject button — don\'t spend multiple turns on consent dialogs.\n'

export interface BrowserAgentOptions {
  driver: Driver;
  config?: AgentConfig;
  /** Called after each turn */
  onTurn?: (turn: Turn) => void;
  /** Called when a first-time phase timing is observed */
  onPhaseTiming?: (phase: 'navigate' | 'observe' | 'decide' | 'execute', durationMs: number) => void;
  /** Reference trajectory to inject into brain context */
  referenceTrajectory?: string;
  /** Project memory store — enables knowledge + selector persistence */
  projectStore?: ProjectStore;
  /** Run registry for orchestration-facing manifests */
  runRegistry?: RunRegistry;
  /**
   * Optional TurnEventBus for sub-turn observability. The runner emits events
   * at every phase boundary (observe-start/end, decide-start/end, execute,
   * verify, recovery, override, turn-start/end). When omitted, a no-op bus is
   * used so existing call sites are unchanged.
   *
   * Subscribers: live SSE viewer, events.jsonl persistence, user extensions.
   */
  eventBus?: TurnEventBus;
  /**
   * Pre-resolved user extensions (loaded from bad.config.{js,mjs,ts} or via
   * --extension flags). The runner subscribes them to the event bus, applies
   * mutateDecision after the LLM decide step, and forwards rule additions to
   * the brain's system prompt composer.
   */
  extensions?: ResolvedExtensions;
}

/**
 * Gen 7.2: detect placeholder patterns in a planner-generated complete.result.
 *
 * The planner has to commit to its `complete.result` text BEFORE any prior
 * runScript step actually runs, so on extraction tasks it fabricates
 * placeholders. We detect those patterns and substitute the runScript
 * output (deterministic, no extra LLM call).
 *
 * Patterns we catch:
 *   - JSON `null` literals (e.g. `{"x": null, "y": null}`)
 *   - "<from prior step>", "<placeholder>", "<value from ...>", "<extracted ...>", "<observed ...>"
 *   - "{{...}}" template markers
 *
 * Conservative on purpose — we only substitute when the planner clearly
 * didn't know real values at planning time. A complete.result that contains
 * actual data (no nulls, no placeholder markers) passes through unchanged.
 */
export function hasPlaceholderPattern(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  if (/<from prior step>|<placeholder>|<value from|<extracted|<observed|<previous step|<runscript output>/i.test(text)) {
    return true
  }
  if (/\{\{[^}]+\}\}/.test(text)) {
    return true
  }
  // JSON-shape detection: a result that parses as JSON and contains null
  // values is almost always a planner-fabricated extraction shell. Pure
  // strings with the word "null" elsewhere don't match because we look
  // for the JSON null literal pattern (`: null` or `[null`).
  if (/:\s*null\b|\[\s*null\b/.test(text)) {
    return true
  }
  return false
}

/**
 * Gen 9 — runtime two-pass extraction. When the planner emits a single
 * runScript step (per Gen 7.2 rule #7) and that script returns null /
 * empty / whitespace / `{x: null}` / a placeholder pattern, the auto-
 * complete-from-runScript path should NOT fire. Instead the runner should
 * mark the plan as deviated and fall through to the per-action loop where
 * Brain.decide can re-observe the loaded page and emit a smarter action
 * (different selector, click+wait, scroll, etc.).
 *
 * This addresses the failure mode the Gen 8 head-to-head gauntlet
 * surfaced: bad's planner-only path lost to browser-use's per-action loop
 * on tasks where the first runScript pick was wrong (npm, mdn signature,
 * w3c, github, wikipedia variance). Two-pass gives bad's per-action loop
 * the same recovery surface browser-use uses, with the planner's speed
 * advantage on the cases where runScript succeeds first try.
 *
 * "Meaningful" means: not empty/whitespace, not the literal string `null`
 * or `undefined`, and not matching `hasPlaceholderPattern` (which already
 * detects JSON null fields, "<from prior step>" markers, etc.).
 */
export function isMeaningfulRunScriptOutput(output: string | null | undefined): boolean {
  if (typeof output !== 'string') return false
  const trimmed = output.trim()
  if (trimmed.length === 0) return false
  if (trimmed === 'null' || trimmed === 'undefined' || trimmed === '""' || trimmed === "''") return false
  // Empty JSON shells: `{}`, `[]`, `{"x": null}`, `[null, null]`
  if (trimmed === '{}' || trimmed === '[]') return false
  if (hasPlaceholderPattern(trimmed)) return false
  // If the output parses as JSON and EVERY top-level value is null/empty,
  // treat it as not meaningful. This catches `{"x": null, "y": ""}` even
  // though the placeholder regex would already catch the null one.
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const values = Object.values(parsed)
      if (values.length > 0) {
        const allEmpty = values.every(
          (v) => v === null || v === undefined || v === '' || v === 0,
        )
        if (allEmpty) return false
      }
    }
    if (Array.isArray(parsed) && parsed.length === 0) return false
  } catch {
    // Not JSON, that's fine — fall through to "meaningful" if we got here.
  }
  return true
}

export class BrowserAgent {
  private driver: Driver;
  private brain: Brain;
  private config: AgentConfig;
  private onTurn?: (turn: Turn) => void;
  private onPhaseTiming?: (phase: 'navigate' | 'observe' | 'decide' | 'execute', durationMs: number) => void;
  private referenceTrajectory?: string;
  private projectStore?: ProjectStore;
  private runRegistry?: RunRegistry;
  private knowledge?: AppKnowledge;
  private selectorCache?: SelectorCache;
  private cachedPostState: PageState | undefined;
  private bus: TurnEventBus;
  private currentRunId = '';
  // In-session decision cache. Lazy-skips brain.decide() when the (snapshot,
  // url, goal, last-effect, budget-bucket) is byte-identical to a previous
  // turn in this run. The cache is fresh per `run()` invocation — never
  // persists, never crosses runs.
  private decisionCache?: DecisionCache;
  private extensions?: ResolvedExtensions;

  constructor(options: BrowserAgentOptions) {
    this.driver = options.driver;
    this.config = options.config || {};
    this.brain = new Brain(this.config);
    this.onTurn = options.onTurn;
    this.onPhaseTiming = options.onPhaseTiming;
    this.referenceTrajectory = options.referenceTrajectory;
    this.bus = ensureBus(options.eventBus);
    this.extensions = options.extensions;
    if (this.extensions) {
      // Forward extension-supplied prompt rules into the brain so they get
      // included in every system prompt build. Domain-keyed rules are
      // matched per-turn against the current URL inside composeSystemPromptParts.
      this.brain.setExtensionRules(
        this.extensions.combinedRules,
        this.extensions.combinedDomainRules,
      );
      // Subscribe extensions to the event bus so onTurnEvent fires for
      // every emitted event without callers having to wire it up.
      this.bus.subscribe(this.extensions.fanOutTurnEvent, false);
    }
    this.projectStore = options.projectStore;
    this.runRegistry = options.runRegistry;
  }

  async run(scenario: Scenario): Promise<AgentResult> {
    // Gen 21: parallel tab execution for compound goals.
    // Pre-flight: check if the goal should be decomposed into parallel sub-goals.
    if (this.config.parallelTabs?.enabled && scenario.goal && scenario.startUrl) {
      const context = this.driver.getPage?.()?.context();
      if (context) {
        const { decomposeGoal } = await import('./goal-decomposer.js');
        const decomposition = await decomposeGoal(
          scenario.goal,
          scenario.startUrl,
          {
            provider: this.config.provider || 'openai',
            model: this.config.navModel || 'gpt-4.1-mini',
            apiKey: this.config.apiKey,
          },
        );
        if (decomposition.type === 'compound' && decomposition.subGoals) {
          const { runParallel } = await import('./parallel-runner.js');
          const result = await runParallel({
            context,
            config: this.config,
            originalGoal: scenario.goal,
            subGoals: decomposition.subGoals,
            scenario,
            onTurn: this.onTurn ? (_label: string, turn: Turn) => this.onTurn!(turn) : undefined,
            projectStore: this.projectStore,
          });
          return {
            success: result.success,
            reason: result.mergedResult,
            turns: [],
            totalMs: result.totalMs,
          } as AgentResult;
        }
      }
    }

    // Gen 14: vision mode gets more turns — each turn takes ~15s (screenshot
    // encode + image tokens) vs ~5s for DOM-first. Without the boost, vision
    // runs out of turns before completing multi-step tasks.
    const isVisionMode = this.config.observationMode === 'vision' || this.config.observationMode === 'hybrid';
    const baseMaxTurns = scenario.maxTurns || DEFAULT_MAX_TURNS;
    // Gen 26: 30 turn minimum for vision. 15/51 failures were turn budget
    // exhaustion at 20. The cost cap (200k tokens) is the real bound.
    const maxTurns = isVisionMode ? Math.max(baseMaxTurns, 30) : baseMaxTurns;
    const retries = this.config.retries ?? DEFAULT_RETRIES;
    const retryDelayMs = this.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const turns: Turn[] = [];
    const startTime = Date.now();
    const phaseTimings: import('../types.js').RunPhaseTimings = {};
    // Gen 27: vision+planner mode gets 3× token budget (300k). Gen 26 showed
    // 4 cost_cap failures and 18 turn-exhausted tasks (now getting 30 turns
    // but hitting 200k cap). The timeout (600s) is the real safety net.
    const visionBudgetMultiplier = isVisionMode ? 3 : 1;
    const runState = new RunState(maxTurns, Math.round(DEFAULT_TOKEN_BUDGET * visionBudgetMultiplier));

    const runId = scenario.sessionId
      ? `${scenario.sessionId}_${Date.now()}`
      : RunRegistry.generateRunId()
    this.currentRunId = runId
    const domain = safeHostname(scenario.startUrl || '') || 'unknown'

    // Emit run-started so subscribers (live viewer, events.jsonl sink) can
    // initialize their state. The bus is a no-op when no eventBus was passed
    // to the constructor, so this is free for non-live runs.
    this.bus.emitNow({
      type: 'run-started',
      runId,
      turn: 0,
      goal: scenario.goal,
      startUrl: scenario.startUrl,
      maxTurns,
    })

    const buildResult = (result: Omit<AgentResult, 'phaseTimings' | 'wasteMetrics'>): AgentResult => {
      const agentResult: AgentResult = {
        ...result,
        phaseTimings,
        wasteMetrics: deriveWasteMetrics(turns, runState.verificationRejectionCount, runState.firstSufficientEvidenceTurn),
      }
      this.saveMemory(scenario, agentResult, turns)
      // Complete run manifest
      const lastTurn = agentResult.turns[agentResult.turns.length - 1]
      this.runRegistry?.completeRun(runId, {
        success: agentResult.success,
        finalUrl: lastTurn?.state?.url,
        summary: agentResult.result || agentResult.reason,
        result: agentResult.result,
        reason: agentResult.reason,
        turnCount: agentResult.turns.length,
      })
      // Emit run-completed so the live viewer can swap to a "finished" UI
      // and the events.jsonl sink can flush its tail.
      this.bus.emitNow({
        type: 'run-completed',
        runId,
        turn: 0,
        success: agentResult.success,
        totalTurns: agentResult.turns.length,
        totalMs: agentResult.totalMs,
        ...(agentResult.reason ? { reason: agentResult.reason } : {}),
      });
      return agentResult
    };

    // Wrap onTurn to include mid-run manifest updates (every 3 turns) and to
    // accumulate per-turn token usage for the Gen 10 cost cap.
    const originalOnTurn = this.onTurn
    this.onTurn = (turn: Turn) => {
      originalOnTurn?.(turn)
      runState.recordTokens(turn.tokensUsed)
      if (this.runRegistry && turns.length % 3 === 0) {
        try {
          this.runRegistry.updateRun(runId, {
            turnCount: turns.length,
            currentUrl: turn.state?.url,
          })
        } catch { /* best-effort */ }
      }
    }

    // Reset brain history for fresh scenario
    this.brain.reset();
    this.cachedPostState = undefined;
    let executeTimeoutRecoveries = 0;

    // Fresh decision cache per run. The cache is strictly in-session — page
    // state changes silently between runs and a stale cached decision is a
    // correctness landmine. Disable via BAD_DECISION_CACHE=0.
    this.decisionCache = process.env.BAD_DECISION_CACHE === '0'
      ? undefined
      : new DecisionCache();
    // Track the previous turn's expectedEffect so we can include it in the
    // cache key. Empty string for turn 1.
    let lastEffectForCacheKey = '';

    // Pre-warm the provider connection in parallel with everything else.
    // Without this, turn 1's first LLM call eats 600ms (Anthropic) to
    // 1200ms (OpenAI) of cold-start TLS+DNS+HTTP/2 setup. By the time
    // navigation + first observe complete, the connection pool is hot.
    // Best-effort: failure is swallowed and turn 1 pays the cold-start.
    const warmupPromise = this.brain.warmup();

    // Start navigation and load memory in parallel. Navigation is async (network
    // I/O) while memory init is sync (readFileSync), so memory completes while
    // the network request is in flight — saving the serial cost of disk reads.
    if (scenario.startUrl) {
      const navigateStartedAt = Date.now();
      const navPromise = withRetry(
        () => this.driver.execute({ action: 'navigate', url: scenario.startUrl! }),
        retries,
        retryDelayMs,
        undefined,
        scenario.signal,
      );

      // Load domain-scoped memory while navigation is in progress
      if (this.projectStore) {
        this.knowledge = new AppKnowledge(
          this.projectStore.getKnowledgePath(scenario.startUrl),
          scenario.startUrl,
        );
        this.selectorCache = new SelectorCache(
          this.projectStore.getSelectorCachePath(scenario.startUrl),
        );
      }

      await navPromise;
      phaseTimings.initialNavigateMs = Date.now() - navigateStartedAt;
      this.onPhaseTiming?.('navigate', phaseTimings.initialNavigateMs);

      // REVERTED: page warm-up delay caused pre-first-turn timeouts on Google
      // Flights (0-turn failures at 600s) and click timeouts on Allrecipes.
      // DataDome bypass needs a different approach — not blocking the main loop.
    }

    // Don't wait on warmup before entering the loop — it races against the
    // first observe and decode. Make sure any unhandled rejection is silenced.
    void warmupPromise.catch(() => undefined);

    // Write run manifest at start
    this.runRegistry?.startRun({
      runId,
      sessionId: scenario.sessionId,
      parentRunId: scenario.parentRunId,
      goal: scenario.goal,
      domain,
      startUrl: scenario.startUrl,
    });

    const supervisorConfig = {
      enabled: this.config.supervisor?.enabled ?? DEFAULT_SUPERVISOR.enabled,
      // Gen 28: models.supervisor overrides supervisor.model, falls back to main
      model: this.config.models?.supervisor?.model || this.config.supervisor?.model || this.config.model || 'gpt-5.4',
      provider: (this.config.models?.supervisor?.provider || this.config.supervisor?.provider || this.config.provider || 'openai') as 'openai' | 'anthropic' | 'google' | 'codex-cli' | 'claude-code' | 'sandbox-backend',
      useVision: this.config.supervisor?.useVision ?? DEFAULT_SUPERVISOR.useVision,
      minTurnsBeforeInvoke: this.config.supervisor?.minTurnsBeforeInvoke ?? DEFAULT_SUPERVISOR.minTurnsBeforeInvoke,
      cooldownTurns: this.config.supervisor?.cooldownTurns ?? DEFAULT_SUPERVISOR.cooldownTurns,
      maxInterventions: this.config.supervisor?.maxInterventions ?? DEFAULT_SUPERVISOR.maxInterventions,
      hardStallWindow: this.config.supervisor?.hardStallWindow ?? DEFAULT_SUPERVISOR.hardStallWindow,
    } as const;

    // Gen 7 / 7.1: planner-first path. When `plannerEnabled: true` (and not
    // disabled via BAD_PLANNER=0), make a single LLM call to generate a
    // plan, then execute it deterministically.
    //
    // Gen 7.1 (replan-on-deviation): when a plan deviates, instead of
    // immediately falling through to the per-action loop, call Brain.plan()
    // AGAIN with the current page state and a deviation context. Cap at
    // `maxReplans` total replan attempts (= initial plan + maxReplans
    // additional plan calls). The system prompt is byte-stable so prompt
    // cache still hits — only the user message carries the deviation
    // history. On exhaustion, fall through to the per-action loop with a
    // [REPLAN] hint, exactly like Gen 7 did.
    //
    // Plan execution writes to the same `turns` array, so post-run analysis
    // sees a unified timeline regardless of which path completed the run.
    let planFallbackContext = ''
    let plannerStartTurn = 0
    const plannerEnabled =
      this.config.plannerEnabled === true && process.env.BAD_PLANNER !== '0'
    const maxReplans = 3
    if (plannerEnabled && scenario.startUrl) {
      // Need an initial observe so the planner has something to look at.
      // The runner's main loop also observes on every iteration; this one
      // primes the planner. The result is also stashed as cachedPostState
      // so the per-action fallback's first observe is short-circuited.
      //
      // Gen 8: on real-web tasks (planner-on-realweb config), wait for
      // the page to settle BEFORE the planner observes. SPA pages like
      // npmjs.com load their data via JS after DOMContentLoaded — without
      // a settle wait the planner snapshots a half-loaded page and emits
      // runScript queries against selectors that don't exist yet.
      const settleMs = this.config.initialObserveSettleMs ?? 0
      if (settleMs > 0) {
        const page = this.driver.getPage?.()
        if (page) {
          await Promise.race([
            page.waitForLoadState('networkidle').catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, settleMs)),
          ])
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, settleMs))
        }
        if (this.config.debug) {
          console.log(`[Runner] Gen 8 initial settle: waited ${settleMs}ms (or networkidle) before planner observe`)
        }
      }
      const initialState = await this.driver.observe().catch(() => undefined)
      if (initialState) {
        this.cachedPostState = initialState
        let planLoopState: PageState = initialState
        let cumulativeTurnsConsumed = 0
        let attempt = 0
        let lastDeviationReason = ''
        let lastFailedStepIndex = 0
        let lastTotalSteps = 0
        let replanLoopDone = false
        let replanLoopCompleted = false
        let lastFinalResult: string | undefined
        let lastCompletedState: PageState = initialState

        while (!replanLoopDone && attempt <= maxReplans) {
          // Re-observe before every replan (attempt > 0); the initial plan
          // already has the freshly-observed state above.
          if (attempt > 0) {
            const reobserved = await this.driver.observe().catch(() => planLoopState)
            planLoopState = reobserved
            this.cachedPostState = reobserved
            this.bus.emitNow({
              type: 'plan-replan-started',
              runId,
              turn: turns.length,
              replanIndex: attempt,
              maxReplans,
              reason: lastDeviationReason,
            })
            if (this.config.debug) {
              console.log(`[Runner] Replan attempt ${attempt}/${maxReplans}: ${lastDeviationReason}`)
            }
          }

          this.bus.emitNow({
            type: 'plan-started',
            runId,
            turn: turns.length,
            goal: scenario.goal,
          })

          const extraContext = attempt === 0
            ? undefined
            : `[REPLAN ${attempt}/${maxReplans}] The previous plan attempt failed at step ${lastFailedStepIndex + 1}/${lastTotalSteps}: ${lastDeviationReason}\nGenerate a FRESH plan from the current page state to complete the goal. Do NOT repeat the failed step verbatim — diagnose why it failed and route around it. Steps already executed in earlier attempts are persisted in the page state below; pick up from there.`

          const planResult = await this.brain.plan(scenario.goal, planLoopState, {
            extraContext,
          }).catch((err) => ({
            plan: null,
            raw: '',
            durationMs: 0,
            parseError: err instanceof Error ? err.message : String(err),
          }))

          if (!planResult.plan || planResult.plan.steps.length === 0) {
            // Planner unavailable / parse failure / zero steps. Fall through.
            if (this.config.debug) {
              console.log(`[Runner] Planner unavailable on attempt ${attempt}: ${(planResult as { parseError?: string }).parseError ?? 'no plan returned'}`)
            }
            replanLoopDone = true
            break
          }

          this.bus.emitNow({
            type: 'plan-completed',
            runId,
            turn: turns.length,
            stepCount: planResult.plan.steps.length,
            plan: planResult.plan,
            durationMs: planResult.durationMs,
            ...(planResult.inputTokens !== undefined ? { inputTokens: planResult.inputTokens } : {}),
            ...(planResult.outputTokens !== undefined ? { outputTokens: planResult.outputTokens } : {}),
            ...(planResult.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: planResult.cacheReadInputTokens } : {}),
          })

          if (this.config.debug) {
            console.log(`[Runner] Plan attempt ${attempt}: ${planResult.plan.steps.length} steps in ${planResult.durationMs}ms`)
          }

          const planResultRun = await this.executePlan(
            planResult.plan,
            scenario,
            runId,
            turns,
            runState,
            cumulativeTurnsConsumed,
            {
              tokensUsed: (planResult as { tokensUsed?: number }).tokensUsed,
              inputTokens: (planResult as { inputTokens?: number }).inputTokens,
              outputTokens: (planResult as { outputTokens?: number }).outputTokens,
              cacheReadInputTokens: (planResult as { cacheReadInputTokens?: number }).cacheReadInputTokens,
              cacheCreationInputTokens: (planResult as { cacheCreationInputTokens?: number }).cacheCreationInputTokens,
            },
          )
          cumulativeTurnsConsumed += planResultRun.turnsConsumed

          if (planResultRun.kind === 'completed') {
            replanLoopCompleted = true
            lastFinalResult = planResultRun.finalResult
            lastCompletedState = planResultRun.lastState
            replanLoopDone = true
            break
          }

          // Deviated. Capture context, then either replan or fall through.
          lastDeviationReason = planResultRun.reason
          lastFailedStepIndex = planResultRun.failedStepIndex
          lastTotalSteps = planResult.plan.steps.length
          planLoopState = planResultRun.lastState
          attempt++
          // Loop continues; if attempt > maxReplans the while-cond exits
          // and we fall through to the per-action loop below.
        }

        if (replanLoopCompleted) {
          // Plan finished without deviation. Synthesize a complete turn if
          // the plan didn't include one explicitly.
          const lastTurn = turns[turns.length - 1]
          if (!lastTurn || lastTurn.action.action !== 'complete') {
            const completeTurn: Turn = {
              turn: turns.length + 1,
              state: lastCompletedState,
              action: { action: 'complete', result: lastFinalResult ?? 'Plan executed successfully' },
              reasoning: 'Plan execution completed',
              durationMs: 0,
            }
            turns.push(completeTurn)
            this.onTurn?.(completeTurn)
          }
          return buildResult({
            success: true,
            result: lastFinalResult ?? 'Plan executed successfully',
            turns,
            totalMs: Date.now() - startTime,
          })
        }

        // All replan attempts (or initial plan) deviated. Fall through to
        // the per-action loop with a [REPLAN] hint that names the final
        // deviation. The per-action loop with Gen 6.1 batch detection will
        // finish the work.
        if (lastDeviationReason) {
          plannerStartTurn = cumulativeTurnsConsumed
          planFallbackContext = `\n[REPLAN] After ${attempt} planner attempt${attempt === 1 ? '' : 's'} (1 initial + ${attempt - 1} replan${attempt === 2 ? '' : 's'}), the planner could not produce a working plan. Final deviation: ${lastDeviationReason}\nThe runner has fallen back to per-action mode. Continue toward the original goal from the current page state.\n`
          this.bus.emitNow({
            type: 'plan-fallback-entered',
            runId,
            turn: turns.length,
            stepsCompleted: lastFailedStepIndex,
            totalSteps: lastTotalSteps,
            fallbackContext: planFallbackContext,
          })
          if (this.config.debug) {
            console.log(`[Runner] Falling back to per-action loop after ${attempt} planner attempts`)
          }
        }
      }
    }

    for (let i = 1 + plannerStartTurn; i <= maxTurns; i++) {
      if (scenario.signal?.aborted) {
        return buildResult({
          success: false,
          reason: scenario.signal.reason || 'Cancelled',
          turns,
          totalMs: Date.now() - startTime,
        });
      }

      // Gen 10: hard cost cap. Stops the per-action loop from burning unbounded
      // tokens on cases where recovery isn't converging (the Gen 9 death-spiral
      // failure mode where reddit hit $0.32 / 173K tokens). The cap is enforced
      // BEFORE the next LLM call so the case aborts cleanly with a reason.
      if (runState.isTokenBudgetExhausted) {
        return buildResult({
          success: false,
          reason: `cost_cap_exceeded: ${runState.totalTokensUsed} tokens used, budget ${runState.tokenBudget}`,
          turns,
          totalMs: Date.now() - startTime,
        });
      }

      const turnStart = Date.now();
      this.bus.emitNow({ type: 'turn-started', runId, turn: i });

      try {
        // -- 1. Check for recovery before observing --
        // Only run analyzeRecovery when there's a non-zero error trail. Used
        // to run unconditionally; lazy-skipping it when there are no recent
        // errors avoids the per-turn cost on the happy path. (Gen 5 lazy
        // decision graph computation, change #20 in the pursuit spec.)
        const hasErrorTrail = turns.length >= 2
          && (runState.consecutiveErrors > 0
            || turns.slice(-5).some((t) => t.error || t.verified === false));
        if (hasErrorTrail) {
          const lastState = turns[turns.length - 1]?.state || { url: '', title: '', snapshot: '' };
          const recovery = analyzeRecovery({
            recentTurns: turns.slice(-5),
            currentState: lastState,
            consecutiveErrors: runState.consecutiveErrors,
          });

          if (recovery) {
            const forcedActionLabel = recovery.forceBrowserAction?.action ?? recovery.forceAction;
            this.bus.emitNow({
              type: 'recovery-fired',
              runId,
              turn: i,
              strategy: recovery.strategy,
              feedback: recovery.feedback,
              ...(forcedActionLabel ? { forcedAction: forcedActionLabel } : {}),
            });
            if (this.config.debug) {
              const forced = recovery.forceBrowserAction
                ? ` (force: ${recovery.forceBrowserAction.action})`
                : recovery.forceAction
                  ? ` (force: ${recovery.forceAction})`
                  : '';
              console.log(`[Runner] Recovery triggered: ${recovery.strategy}${forced}`);
            }

            // Execute concrete recovery action before injecting feedback
            if (recovery.forceBrowserAction) {
              try {
                await this.driver.execute(recovery.forceBrowserAction);
              } catch (recoveryErr) {
                if (this.config.debug) {
                  console.log(
                    `[Runner] Recovery ${recovery.forceBrowserAction.action} failed: ` +
                    `${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`
                  );
                }
              }
            } else if (recovery.forceAction) {
              try {
                switch (recovery.forceAction) {
                  case 'reload':
                    await this.driver.execute({ action: 'navigate', url: lastState.url });
                    break;
                  case 'escape':
                    await this.driver.execute({ action: 'press', selector: 'body', key: 'Escape' });
                    break;
                  case 'scrollTop':
                    await this.driver.execute({ action: 'scroll', direction: 'up', amount: 2000 });
                    break;
                }
              } catch (recoveryErr) {
                if (this.config.debug) {
                  console.log(`[Runner] Recovery ${recovery.forceAction} failed: ${recoveryErr instanceof Error ? recoveryErr.message : recoveryErr}`);
                }
              }
            }

            // Inject feedback into brain conversation
            this.brain.injectFeedback(recovery.feedback);

            if (recovery.waitMs) {
              await new Promise(r => setTimeout(r, recovery.waitMs));
            }
          }
        }

        // -- 2. Observe (with retry) --
        // Reuse the snapshot from verifyEffect if available (no page mutations between them)
        const observeStartedAt = Date.now();
        this.bus.emitNow({ type: 'observe-started', runId, turn: i });
        const state = this.cachedPostState ?? await withRetry(
          () => this.driver.observe(),
          1, // Observe failures are DOM access issues, not transient — retrying 3x wastes 3s
          retryDelayMs,
          (attempt, err) => {
            if (this.config.debug) {
              console.log(`[Runner] Observe retry ${attempt}: ${err.message}`);
            }
          },
          scenario.signal,
        );
        this.cachedPostState = undefined;
        const observeDurationMs = Date.now() - observeStartedAt;
        if (phaseTimings.firstObserveMs === undefined) {
          phaseTimings.firstObserveMs = observeDurationMs;
          this.onPhaseTiming?.('observe', phaseTimings.firstObserveMs);
        }
        // Snapshot bytes only — never wire the full snapshot, it's huge.
        // Screenshot data URL travels through observe-completed when vision
        // is on so the live viewer can render it without a separate fetch.
        const screenshotDataUrl = state.screenshot
          ? (state.screenshot.startsWith('data:')
            ? state.screenshot
            : `data:image/jpeg;base64,${state.screenshot}`)
          : undefined;
        this.bus.emitNow({
          type: 'observe-completed',
          runId,
          turn: i,
          url: state.url,
          title: state.title,
          snapshotBytes: state.snapshot.length,
          ...(screenshotDataUrl ? { screenshot: screenshotDataUrl } : {}),
          durationMs: observeDurationMs,
        });

        // Auto-navigate: if we're on about:blank with a startUrl, navigate without
        // consuming an LLM turn. The agent always does wait->navigate on blank pages.
        if (
          state.url === 'about:blank' &&
          scenario.startUrl &&
          turns.length === 0
        ) {
          await this.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
          // Re-observe after navigation
          const reState = await withRetry(
            () => this.driver.observe(),
            retries,
            retryDelayMs,
            undefined,
            scenario.signal,
          );
          Object.assign(state, reState);
        }

        let terminalBlocker = detectTerminalBlocker(state);
        // Attempt CAPTCHA solving only if: bot-challenge, enabled, and evidence suggests a solvable CAPTCHA
        if (
          terminalBlocker?.kind === 'bot-challenge'
          && this.config.captcha?.enabled !== false
          && canAttemptSolve(terminalBlocker.evidence)
        ) {
          const page = this.driver.getPage?.()
          if (page) {
            try {
              const model = await this.brain.getLanguageModel()
              const captchaResult = await solveCaptcha(page, model, {
                maxAttempts: this.config.captcha?.maxAttempts ?? 5,
              })
              if (captchaResult.success) {
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
                const postCaptchaState = await this.driver.observe()
                Object.assign(state, postCaptchaState)
                this.brain.injectFeedback(
                  `CAPTCHA solved: ${captchaResult.type} in ${captchaResult.attempts} attempt(s), ${captchaResult.durationMs}ms. Continuing.`
                )
                terminalBlocker = detectTerminalBlocker(state)
              }
            } catch (captchaErr) {
              if (this.config.debug) {
                console.log('[Runner] CAPTCHA solve error:', captchaErr instanceof Error ? captchaErr.message : String(captchaErr));
              }
            }
          }
        }
        if (terminalBlocker) {
          const reason = `${terminalBlocker.reason} (signals: ${terminalBlocker.evidence.join(', ')})`;
          const blockerTurn: Turn = {
            turn: i,
            state,
            action: { action: 'abort', reason },
            reasoning: terminalBlocker.strategy,
            durationMs: Date.now() - turnStart,
          };
          turns.push(blockerTurn);
          this.onTurn?.(blockerTurn);
          return buildResult({
            success: false,
            reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }
        const persistentTerminalBlocker = detectPersistentTerminalBlocker(turns, state);
        if (persistentTerminalBlocker) {
          const reason = `${persistentTerminalBlocker.reason} (signals: ${persistentTerminalBlocker.evidence.join(', ')})`;
          const blockerTurn: Turn = {
            turn: i,
            state,
            action: { action: 'abort', reason },
            reasoning: persistentTerminalBlocker.strategy,
            durationMs: Date.now() - turnStart,
          };
          turns.push(blockerTurn);
          this.onTurn?.(blockerTurn);
          return buildResult({
            success: false,
            reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        const ctxBudget = new ContextBudget();

        // Post-blocker-dismissal: if the previous turn's recovery dismissed a modal
        // and the URL hasn't changed, warn the agent that prior actions may have been voided.
        if (turns.length >= 2) {
          const prevTurn = turns[turns.length - 1];
          const prevPrevTurn = turns.length >= 3 ? turns[turns.length - 2] : undefined;
          const prevStrategy = prevTurn?.reasoning || '';
          const modalWasDismissed =
            prevStrategy.includes('cookie/consent dialog') ||
            prevStrategy.includes('dialog/modal is obstructing') ||
            prevStrategy.includes('dialog/modal is present') ||
            (prevTurn?.action?.action === 'click' &&
              /reject|accept|allow|deny|dismiss|consent|cookie/i.test(
                prevTurn?.action?.selector || prevTurn?.rawLLMResponse || '',
              ));
          if (modalWasDismissed && prevPrevTurn && state.url === prevPrevTurn.state.url) {
            ctxBudget.add('blocker-recovery',
              '\nDialog dismissed but URL unchanged — prior action may have been voided. Re-submit if needed.\n', 90);
          }
        }

        // Gen 6.1: Mandatory batch fill detection.
        //
        // If the agent has done 3+ consecutive single-step `type` actions on
        // the same URL (i.e., it's filling a multi-field form one input at a
        // time), inject a high-priority hint into extraContext that DEMANDS
        // the next action be a `fill` covering the remaining fields.
        //
        // This is the runner-side enforcement layer for Gen 6 batch verbs.
        // Prompt rules alone (Gen 6) didn't reliably steer the agent toward
        // batch fill — runtime feedback does.
        const batchFillHint = detectBatchFillOpportunity(turns, state);
        if (batchFillHint && process.env.BAD_BATCH_HINT !== '0') {
          ctxBudget.add('mandatory-batch-fill', batchFillHint, 100);
        }

        const turnsLeft = maxTurns - i + 1;
        if (turnsLeft <= 3) {
          const finalTurnSuffix = turnsLeft === 1
            ? ' FINAL TURN: return complete or abort now.'
            : '';
          ctxBudget.add('turn-budget',
            `\nBUDGET: ${turnsLeft} turn(s) left. Extract data and finish.${finalTurnSuffix}\n`, 100);
        } else if (i >= Math.floor(maxTurns * 0.5) && runState.goalVerificationEvidence.length === 0) {
          ctxBudget.add('extraction-reminder',
            '\nHALF BUDGET USED, no data extracted. Use runScript NOW to extract from current page and complete.\n', 85);
        }

        if (i >= 8 && i < Math.floor(maxTurns * 0.5) && runState.goalVerificationEvidence.length === 0) {
          const isFilterTask = /filter|under \$|over \$|\d+\+ (star|rating)|sort by|price range|less than/i.test(scenario.goal);
          if (isFilterTask) {
            ctxBudget.add('filter-strategy',
              '\nFILTER GOAL: use runScript to find filter controls, apply filter, extract results.\n', 80);
          }
        }

        const searchResultsGuidance = buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains);
        if (searchResultsGuidance) {
          ctxBudget.add('search-guidance', `\n${searchResultsGuidance}\n`, 70);
        }
        const visibleLinkMatch = getVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        const visibleLinkRecommendation = buildVisibleLinkRecommendation(state, scenario.goal, scenario.allowedDomains);
        if (visibleLinkRecommendation) {
          ctxBudget.add('visible-link', `\n${visibleLinkRecommendation}\n`, 60);
        }
        // Gate scout calls: skip on early turns unless the agent appears
        // stuck (same URL for 2+ consecutive turns). On early turns the agent
        // is just navigating and doesn't need link recommendations.
        const stuckOnSameUrl = turns.length >= 2 &&
          turns[turns.length - 1]!.state.url === turns[turns.length - 2]!.state.url;
        const shouldScout = i >= 5 || stuckOnSameUrl;

        let scoutLinkRecommendation: Awaited<ReturnType<BrowserAgent['buildVisibleLinkScoutRecommendation']>>;
        let branchLinkRecommendation: Awaited<ReturnType<BrowserAgent['buildBranchLinkRecommendation']>>;
        let searchScoutFeedback: string;

        if (shouldScout) {
          [scoutLinkRecommendation, branchLinkRecommendation, searchScoutFeedback] = await Promise.all([
            this.buildVisibleLinkScoutRecommendation(state, scenario.goal, scenario.allowedDomains),
            this.buildBranchLinkRecommendation(state, scenario.goal, scenario.allowedDomains),
            this.buildSearchResultsScoutFeedback(state, scenario.goal, scenario.allowedDomains, runState.searchScoutUrls),
          ]);
        } else {
          scoutLinkRecommendation = undefined;
          branchLinkRecommendation = undefined;
          searchScoutFeedback = '';
        }
        if (scoutLinkRecommendation) {
          ctxBudget.add('scout-link', `\n${buildScoutLinkRecommendationText(scoutLinkRecommendation)}\n`, 55);
        }
        if (branchLinkRecommendation) {
          ctxBudget.add('branch-link', `\n${buildBranchLinkRecommendationText(branchLinkRecommendation)}\n`, 55);
        }
        if (searchScoutFeedback) {
          ctxBudget.add('search-scout', `\n${searchScoutFeedback}\n`, 50);
        }
        // Lazy supervisor signal: only compute when supervisor is enabled
        // AND we're past the minimum-turns gate. Used to run unconditionally
        // every turn even when supervisor was disabled. Gen 5 evolve round 1.
        const supervisorEligible =
          supervisorConfig.enabled &&
          i >= supervisorConfig.minTurnsBeforeInvoke &&
          runState.supervisorInterventions < supervisorConfig.maxInterventions &&
          i - runState.lastSupervisorTurn > supervisorConfig.cooldownTurns;
        const supervisorSignal = supervisorEligible
          ? detectSupervisorSignal({
              recentTurns: turns,
              currentState: state,
              currentTurn: i,
              maxTurns,
              window: supervisorConfig.hardStallWindow,
            })
          : { severity: 'none' as const, reasons: [] };
        const shouldInvokeSupervisor =
          supervisorEligible && supervisorSignal.severity === 'hard';

        if (shouldInvokeSupervisor) {
          if (this.config.debug) {
            console.log(`[Runner] Supervisor invoked on turn ${i}: ${formatSupervisorSignal(supervisorSignal)}`);
          }

          let directive: Awaited<ReturnType<typeof requestSupervisorDirective>>;
          try {
            directive = await requestSupervisorDirective({
              goal: scenario.goal,
              currentState: state,
              recentTurns: turns.slice(-8),
              signal: supervisorSignal,
              provider: supervisorConfig.provider,
              model: supervisorConfig.model,
              useVision: supervisorConfig.useVision,
              apiKey: this.config.apiKey,
              baseUrl: this.config.baseUrl,
              timeoutMs: this.config.llmTimeoutMs ?? 60_000,
              debug: this.config.debug,
              sandboxBackendType: this.config.sandboxBackendType,
              sandboxBackendProfile: this.config.sandboxBackendProfile,
              sandboxBackendProvider: this.config.sandboxBackendProvider,
            });
          } catch (supervisorErr) {
            if (this.config.debug) {
              console.log(
                `[Runner] Supervisor call failed: ${supervisorErr instanceof Error ? supervisorErr.message : supervisorErr}`,
              );
            }
            directive = { decision: 'none', reason: 'supervisor call failed' };
          }

          if (directive.decision !== 'none') {
            runState.supervisorInterventions++;
            runState.lastSupervisorTurn = i;

            if (directive.feedback) {
              this.brain.injectFeedback(
                `[SUPERVISOR] ${directive.feedback}\n` +
                `Signal: ${formatSupervisorSignal(supervisorSignal)}`
              );
            }

            if (directive.decision === 'abort') {
              const reason = directive.reason || directive.feedback || 'Supervisor aborted due to hard stall';
              const supervisorTurn: Turn = {
                turn: i,
                state,
                action: { action: 'abort', reason },
                rawLLMResponse: directive.raw,
                reasoning: directive.reason || directive.feedback,
                durationMs: Date.now() - turnStart,
              };
              turns.push(supervisorTurn);
              this.onTurn?.(supervisorTurn);
              return buildResult({
                success: false,
                reason,
                turns,
                totalMs: Date.now() - startTime,
              });
            }

            if (directive.decision === 'force_action' && directive.action) {
              let actionError: string | undefined;
              try {
                const forceResult = await withRetry(
                  () => this.driver.execute(directive.action!),
                  retries,
                  retryDelayMs,
                  (attempt, err) => {
                    if (this.config.debug) {
                      console.log(`[Runner] Supervisor force-action retry ${attempt}: ${err.message}`);
                    }
                  },
                  scenario.signal,
                );
                if (!forceResult.success) {
                  actionError = forceResult.error || 'Supervisor force_action failed';
                }
              } catch (err) {
                actionError = err instanceof Error ? err.message : String(err);
              }

              if (actionError) {
                runState.recordError();
              } else {
                runState.clearConsecutiveErrors();
              }

              const supervisorTurn: Turn = {
                turn: i,
                state,
                action: directive.action,
                rawLLMResponse: directive.raw,
                reasoning: directive.reason || directive.feedback || 'Supervisor intervention',
                durationMs: Date.now() - turnStart,
                ...(actionError ? { error: actionError } : {}),
              };
              turns.push(supervisorTurn);
              this.onTurn?.(supervisorTurn);

              if (runState.hasConsecutiveErrorThreshold) {
                return buildResult({
                  success: false,
                  reason: `${runState.consecutiveErrors} consecutive errors after supervisor action: ${actionError}`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }
              if (runState.isErrorBudgetExhausted) {
                return buildResult({
                  success: false,
                  reason: `Error budget exhausted (${runState.totalErrors}/${runState.maxTotalErrors}) after supervisor action`,
                  turns,
                  totalMs: Date.now() - startTime,
                });
              }

              continue;
            }

            if (directive.decision === 'inject_feedback') {
              const feedback = directive.feedback || directive.reason || 'Supervisor detected a hard stall. Switch strategy.';
              ctxBudget.add('supervisor', `\nSUPERVISOR GUIDANCE: ${feedback}\nSignal: ${formatSupervisorSignal(supervisorSignal)}\n`, 95);
            }
          }
        }

        // -- 3. Build extra context --

        // Inject DeFi/crypto app awareness when wallet mode is active (first turn only)
        if (this.config.walletMode && i === 1) {
          ctxBudget.add('wallet-defi-context', DEFI_BRAIN_CONTEXT, 35);
        }

        if (this.referenceTrajectory) {
          ctxBudget.add('reference-trajectory',
            `\nREFERENCE TRAJECTORY — A similar task was completed before:\n${this.referenceTrajectory}\nUse this as a guide, but adapt to the current page state.\n`, 40);
        }

        // Inject persistent knowledge from previous runs
        if (this.knowledge) {
          const knowledgeContext = this.knowledge.formatForBrain();
          if (knowledgeContext) {
            ctxBudget.add('knowledge', `\n${knowledgeContext}\n`, 30);
          }
        }
        if (this.selectorCache) {
          const selectorContext = this.selectorCache.formatForBrain();
          if (selectorContext) {
            ctxBudget.add('selector-cache', `\n${selectorContext}\n`, 25);
          }
        }

        // Check if last turn had a verification failure
        const lastTurn = turns[turns.length - 1];
        if (lastTurn?.verificationFailure) {
          ctxBudget.add('verification-failure',
            `\nVERIFICATION FAILED: ${lastTurn.verificationFailure}. Try different approach.\n`, 85);
        }

        // Extraction guard: if the agent just ran a script that returned data,
        // remind it to consider completing before navigating away.
        if (lastTurn?.action.action === 'runScript' && !lastTurn.error) {
          ctxBudget.add('extraction-guard',
            '\nData extracted. If it answers the goal, complete now.\n', 80);
        }

        // REVERTED: form stall → DDG/external search fallback. Caused the agent
        // to navigate to Priceline, Expedia, DuckDuckGo which all block with
        // anti-bot. Worse than staying on the original site and grinding.
        // The stall detection idea is sound but the fallback destination is wrong.
        // TODO: revisit with a same-site strategy (runScript extraction, URL
        // construction from current state) instead of cross-site navigation.
        {
        }

        const extraContext = ctxBudget.build();

        const forceVision = shouldEscalateVision({
          config: this.config,
          state,
          turns,
          scenario,
          currentTurn: i,
          maxTurns,
          supervisorSignalSeverity: supervisorSignal.severity,
          extraContext,
        });
        const aiTanglePartnerCompletion = detectAiTanglePartnerTemplateVisibleState(state, scenario.goal);
        const aiTanglePartnerContext = aiTanglePartnerCompletion
          ? `\nPARTNER TEMPLATE VISIBILITY DETECTED:\n${aiTanglePartnerCompletion.feedback}\nReturn a terminal \`complete\` action now with concrete evidence.\n`
          : '';
        const aiTangleOutputCompletion = detectAiTangleVerifiedOutputState(state, scenario.goal);
        const aiTangleOutputContext = aiTangleOutputCompletion
          ? `\nVERIFIED OUTPUT STATE DETECTED:\n${aiTangleOutputCompletion.feedback}\nReturn a terminal \`complete\` action now with concrete evidence.\n`
          : '';
        // Gen 7: include the plan fallback hint on the FIRST per-action turn
        // after a plan deviation. The hint tells the LLM what failed and from
        // what point to recover. We only inject it once (consume it after
        // first use) so it doesn't pollute every subsequent turn.
        const planFallbackHint = planFallbackContext
        if (planFallbackContext) planFallbackContext = ''
        const finalExtraContext = [extraContext, aiTanglePartnerContext, aiTangleOutputContext, planFallbackHint].filter(Boolean).join('');
        const decisionState = forceVision
          ? await this.attachDecisionScreenshot(state)
          : state;

        // -- 4. Decide (deterministic patterns → cache → LLM) --
        const decideStartedAt = Date.now();
        this.bus.emitNow({ type: 'decide-started', runId, turn: i });

        // Lazy decisions, level 1: deterministic UI pattern matching.
        //
        // Patterns look at the SNAPSHOT TEXT only — they don't care about
        // extraContext, persona injection, vision strategy, or anything
        // else the LLM would consume. A cookie banner is a cookie banner
        // regardless of what the goal text says or whether the screenshot
        // is attached. So the only gate is "did the previous turn fail" —
        // if so, give the LLM a chance to course-correct instead of
        // mechanically retrying the same pattern action.
        const previousTurn = turns[turns.length - 1];
        const canPatternSkip =
          !previousTurn?.error
          && !previousTurn?.verificationFailure
          && process.env.BAD_PATTERN_SKIP !== '0';

        let patternMatch: ReturnType<typeof matchDeterministicPattern> = null;
        if (canPatternSkip) {
          patternMatch = matchDeterministicPattern(decisionState);
        }

        // Lazy decisions, level 2: in-session decision cache.
        //
        // The cache DOES care about extraContext: a cached decision was
        // made under one set of context inputs, and replaying it under a
        // different set could be wrong. Include the extraContext check
        // here so the cache only fires when the LLM input would have been
        // the same shape.
        const canUseCache =
          this.decisionCache !== undefined
          && canPatternSkip
          && !patternMatch
          && !finalExtraContext;
        const cacheKey = canUseCache
          ? {
              snapshotHash: DecisionCache.hashSnapshot(decisionState.snapshot),
              url: decisionState.url,
              goal: scenario.goal,
              lastEffect: lastEffectForCacheKey,
              budgetBucket: DecisionCache.budgetBucket(i, maxTurns),
            }
          : undefined;
        const cached = canUseCache && cacheKey
          ? this.decisionCache!.get(cacheKey)
          : undefined;

        let decision: Awaited<ReturnType<Brain['decide']>>;
        if (patternMatch) {
          // Pattern match — synthesize a decision, no LLM call.
          decision = {
            action: patternMatch.action,
            raw: '[deterministic-pattern]',
            reasoning: patternMatch.reasoning,
            expectedEffect: patternMatch.expectedEffect,
            tokensUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
          };
          this.bus.emitNow({
            type: 'decide-skipped-pattern',
            runId,
            turn: i,
            action: decision.action,
            patternId: patternMatch.patternId,
          });
          if (this.config.debug) {
            console.log(`[Runner] Pattern SKIP (${patternMatch.patternId}, turn ${i}) — skipping LLM`);
          }
        } else if (cached) {
          // Cache hit — replay the decision, no LLM call.
          decision = cached.decision;
          this.bus.emitNow({
            type: 'decide-skipped-cached',
            runId,
            turn: i,
            action: decision.action,
            cacheKey: cached.hash,
          });
          if (this.config.debug) {
            console.log(`[Runner] Decision cache HIT (turn ${i}, key ${cached.hash.slice(0, 8)}…) — skipping LLM`);
          }
        } else {
          // REVERTED: micro-movements during LLM thinking caused interference
          // with page state on interactive sites. The mouse.move calls during
          // decide() could trigger hover states, tooltips, or dismiss elements
          // the agent was about to click.

          decision = await withRetry(
            () => this.brain.decide(
              scenario.goal,
              decisionState,
              finalExtraContext || undefined,
              { current: i, max: maxTurns },
              { forceVision },
            ),
            retries,
            retryDelayMs,
            (attempt, err) => {
              if (this.config.debug) {
                console.log(`[Runner] LLM retry ${attempt}: ${err.message}`);
              }
            },
            scenario.signal,
          );
          if (cacheKey && this.decisionCache) {
            // Store the fresh decision so a future identical turn replays it.
            this.decisionCache.set(cacheKey, decision);
          }
        }

        const decideDurationMs = Date.now() - decideStartedAt;
        if (phaseTimings.firstDecideMs === undefined) {
          phaseTimings.firstDecideMs = decideDurationMs;
          this.onPhaseTiming?.('decide', phaseTimings.firstDecideMs);
        }

        let { action, nextActions, raw, reasoning, plan, currentStep, expectedEffect, tokensUsed, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, modelUsed } = decision;
        // Only emit decide-completed when the LLM was actually called.
        // Pattern matches and cache hits already emitted their own
        // decide-skipped-* event above; double-emitting decide-completed
        // would inflate the LLM-call count for analytics.
        if (!patternMatch && !cached) {
          this.bus.emitNow({
            type: 'decide-completed',
            runId,
            turn: i,
            action,
            ...(reasoning ? { reasoning } : {}),
            ...(expectedEffect ? { expectedEffect } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
            durationMs: decideDurationMs,
          });
        }

        // -- 4b. Override pipeline — scored selection of post-decision overrides --
        const overrideCtx: OverrideContext = {
          state,
          goal: scenario.goal,
          allowedDomains: scenario.allowedDomains,
          action,
          visibleLinkMatch,
          scoutLinkRecommendation,
          branchLinkRecommendation,
          aiTanglePartnerCompletion: aiTanglePartnerCompletion ?? undefined,
          aiTangleOutputCompletion: aiTangleOutputCompletion ?? undefined,
        };
        // Lazy override pipeline: only run when at least one input that any
        // producer might consume is non-null. Skipping when there's nothing
        // to override avoids the producer-list iteration on the happy path.
        const anyOverrideInput =
          visibleLinkMatch !== undefined ||
          scoutLinkRecommendation !== undefined ||
          branchLinkRecommendation !== undefined ||
          aiTanglePartnerCompletion !== null ||
          aiTangleOutputCompletion !== null;
        const overrideWinner = anyOverrideInput
          ? runOverridePipeline(overrideCtx, buildOverrideProducers())
          : null;
        if (overrideWinner) {
          this.brain.injectFeedback(overrideWinner.feedback);
          action = overrideWinner.action;
          reasoning = `${reasoning}\n[${overrideWinner.reasoningTag}] ${overrideWinner.feedback}`;
          expectedEffect = overrideWinner.expectedEffect;
          nextActions = [];
          this.bus.emitNow({
            type: 'override-applied',
            runId,
            turn: i,
            source: 'override-pipeline',
            reasoningTag: overrideWinner.reasoningTag,
            feedback: overrideWinner.feedback,
          });
        }

        // -- 4c. User extension mutateDecision (final say) --
        // Runs AFTER the built-in override pipeline so user extensions can
        // veto or replace any decision the built-ins might have produced.
        // Mutations are emitted as override events on the bus for audit.
        if (this.extensions?.applyMutateDecision) {
          const mutated = this.extensions.applyMutateDecision(
            { ...decision, action, reasoning, expectedEffect },
            {
              goal: scenario.goal,
              turn: i,
              maxTurns,
              state: decisionState,
              ...(turns[turns.length - 1]?.error
                ? { lastError: turns[turns.length - 1]!.error }
                : {}),
            },
          );
          if (mutated.mutated) {
            action = mutated.decision.action;
            reasoning = mutated.decision.reasoning ?? reasoning;
            expectedEffect = mutated.decision.expectedEffect ?? expectedEffect;
            this.bus.emitNow({
              type: 'override-applied',
              runId,
              turn: i,
              source: 'extension',
              reasoningTag: mutated.sources.join(','),
              feedback: 'extension mutateDecision applied',
            });
          }
        }

        const turn: Turn = {
          turn: i,
          state: decisionState,
          action,
          rawLLMResponse: raw,
          reasoning,
          plan,
          currentStep,
          expectedEffect,
          tokensUsed,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          modelUsed,
          durationMs: Date.now() - turnStart,
        };
        const executedActions: Action[] = [action];

        // -- 5. Handle evaluate action --
        if (action.action === 'evaluate') {
          const evaluation = await this.brain.evaluate(state, scenario.goal);

          // Inject evaluation results as feedback so Brain can act on them
          this.brain.injectFeedback(
            `QUALITY EVALUATION (score: ${evaluation.score}/10):\n` +
            `Assessment: ${evaluation.assessment}\n` +
            `Strengths: ${evaluation.strengths.join(', ')}\n` +
            `Issues: ${evaluation.issues.join(', ')}\n` +
            `Suggestions: ${evaluation.suggestions.join(', ')}`
          );

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue; // Let the agent decide next action based on evaluation feedback
        }

        // -- 5b. Handle verifyPreview action --
        if (action.action === 'verifyPreview') {
          const page = this.driver.getPage?.();
          if (page) {
            const snapshot = new AriaSnapshotHelper();
            const preview = await verifyPreview(page, snapshot, { captureScreenshot: false });
            if (preview) {
              const statusLine = preview.appLoaded ? 'LOADED' : 'FAILED';
              const errorsLine = preview.errors.length > 0
                ? `\nErrors: ${preview.errors.join('; ')}`
                : '';
              this.brain.injectFeedback(
                `PREVIEW VERIFICATION (${statusLine}):\n` +
                `URL: ${preview.previewUrl}\n` +
                `Title: ${preview.title}${errorsLine}\n` +
                `App a11y tree:\n${preview.snapshot}`
              );
            } else {
              this.brain.injectFeedback(
                'PREVIEW VERIFICATION: No preview iframe found on the current page. ' +
                'The app may not have a running preview yet.'
              );
            }
          } else {
            this.brain.injectFeedback(
              'PREVIEW VERIFICATION: Cannot access page — driver does not expose a Playwright page.'
            );
          }

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 5c. Handle runScript action --
        if (action.action === 'runScript') {
          const page = this.driver.getPage?.();
          if (page) {
            try {
              const scriptResult = await page.evaluate(action.script);
              const stringified = typeof scriptResult === 'string'
                ? scriptResult
                : JSON.stringify(scriptResult, null, 2);
              runState.firstSufficientEvidenceTurn ??= i;
              pushGoalVerificationEvidence(runState.goalVerificationEvidence, `SCRIPT RESULT:\n${stringified ?? '(undefined)'}`);
              if (typeof stringified === 'string' && stringified.length > 10) {
                runState.recordEvidence(`EXTRACTED (turn ${i}): ${stringified.slice(0, 500)}`);
              }
              this.brain.injectFeedback(
                `SCRIPT RESULT:\n${stringified ?? '(undefined)'}`
              );
            } catch (scriptErr: unknown) {
              const msg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
              this.brain.injectFeedback(
                `SCRIPT ERROR: ${msg}`
              );
            }
          } else {
            this.brain.injectFeedback(
              'SCRIPT ERROR: Cannot access page — driver does not expose a Playwright page.'
            );
          }

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 5d. Handle extractWithIndex action (Gen 10) --
        // Returns a numbered list of every visible element matching `query`,
        // each with its tag, textContent, key attributes, and a stable
        // selector. The agent picks elements by index in the next turn.
        // This is the Gen 10 capability change: pick-by-content instead of
        // pick-by-selector. Works on data the planner couldn't see at plan
        // time (XHR-loaded content, dl/dt/dd, deeply-nested wrappers).
        if (action.action === 'extractWithIndex') {
          const page = this.driver.getPage?.();
          if (page) {
            try {
              const matches = await runExtractWithIndex(page, action.query, action.contains);
              const formatted = formatExtractWithIndexResult(matches, action.query, action.contains);
              runState.firstSufficientEvidenceTurn ??= i;
              pushGoalVerificationEvidence(
                runState.goalVerificationEvidence,
                `EXTRACT RESULT (${matches.length} matches):\n${formatted}`,
              );
              if (formatted.length > 10) {
                runState.recordEvidence(`EXTRACTED (turn ${i}): ${formatted.slice(0, 500)}`);
              }
              this.brain.injectFeedback(
                `EXTRACT RESULT (${matches.length} matches for query "${action.query}"${action.contains ? ` containing "${action.contains}"` : ''}):\n${formatted}`,
              );
            } catch (extractErr: unknown) {
              const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
              this.brain.injectFeedback(
                `EXTRACT ERROR: ${msg}`,
              );
            }
          } else {
            this.brain.injectFeedback(
              'EXTRACT ERROR: Cannot access page — driver does not expose a Playwright page.',
            );
          }

          turn.durationMs = Date.now() - turnStart;
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 6. Check for terminal actions --
        if (action.action === 'complete') {
          // Step 1: Goal verification — did the agent actually achieve the goal?
          const shouldVerifyGoal = this.config.goalVerification !== false;
          let goalResult: import('../types.js').GoalVerification | undefined;
          const persistentSearchEvidence = collectSearchWorkflowEvidence(
            scenario.goal,
            action.result || '',
            turns,
          );
          const verificationEvidence = [
            ...runState.goalVerificationEvidence,
            ...runState.extractedEvidence,
            ...persistentSearchEvidence,
          ];

          if (shouldVerifyGoal) {
            // Fast-path: skip LLM verification when agent provides strong
            // evidence and had no recent errors. The detailed result text
            // (>50 chars) combined with script-extracted evidence means the
            // verifier almost always agrees — save the round-trip.
            //
            // Gen 12: content-aware gate. gpt-5.4 writes verbose narratives
            // that admit failure ("could not complete", "not visible", "did
            // not take effect") yet marks success. The old heuristic (length
            // + evidence + no errors) rubber-stamped these. Now we scan the
            // result text for self-contradicting phrases and force LLM
            // verification when found. This fixes the 6/8 judge disagreement
            // cases from Gen 11 evolve R2.
            const agentResult = action.result || '';
            const recentErrors = turns.slice(-2).filter(t => t.error).length;
            const hasScriptEvidence = verificationEvidence.some(e => e.startsWith('SCRIPT RESULT:'));

            // Content-aware gate: detect when the agent's own text admits
            // failure despite claiming success. These phrases were found in
            // 6 of 8 false-pass cases on WebVoyager with gpt-5.4.
            const selfContradicting = /\b(?:could not (?:complete|find|fulfill|verify|confirm|locate|access|extract|retrieve)|not (?:visible|available|found|present|accessible|displayed|shown|confirmed|verified)|did not (?:take effect|work|succeed|load|return)|unable to (?:find|complete|verify|access|extract|retrieve)|no (?:visible (?:answer|result|data|content)|results? (?:found|returned|available))|(?:failed|failure) to (?:find|complete|set|select|navigate)|unfortunately|I (?:was|am) unable|(?:task|request|goal) (?:is|was) (?:not |in)complete)\b/i.test(agentResult);
            const fastPathEligible =
              agentResult.length > 50 &&
              recentErrors === 0 &&
              hasScriptEvidence &&
              !selfContradicting;

            if (fastPathEligible) {
              goalResult = {
                achieved: true,
                confidence: 0.9,
                evidence: ['Fast-path: agent provided detailed result with script-backed evidence, no recent errors, and no self-contradicting language.'],
                missing: [],
              };
              if (this.config.debug) {
                console.log('[Runner] Goal verification fast-path: skipped LLM call (strong evidence + no errors + no self-contradiction)');
              }
            } else if (selfContradicting) {
              // Force LLM verification — the agent claims success but its
              // own text suggests failure. The LLM verifier reads the actual
              // content and makes the right call.
              if (this.config.debug) {
                console.log('[Runner] Gen 12: fast-path BLOCKED — agent result contains self-contradicting language, forcing LLM verification');
              }
              goalResult = await this.brain.verifyGoalCompletion(
                state,
                scenario.goal,
                buildGoalVerificationClaim(agentResult, verificationEvidence),
              );
            } else {
              goalResult = await this.brain.verifyGoalCompletion(
                state,
                scenario.goal,
                buildGoalVerificationClaim(agentResult, verificationEvidence),
              );
            }

            if (this.config.debug) {
              console.log(`[Runner] Goal verification: achieved=${goalResult.achieved}, confidence=${goalResult.confidence}`);
            }

            if (
              !goalResult.achieved
              && shouldAcceptFirstPartyBoundaryCompletion(
                scenario.goal,
                state.url,
                goalResult,
                action.result || '',
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.8),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under first-party sibling subdomain policy after substantive result evidence was captured.',
                ],
                missing: [],
              };
            }

            if (
              !goalResult.achieved
              && shouldAcceptSearchWorkflowCompletion(
                scenario.goal,
                goalResult,
                action.result || '',
                verificationEvidence,
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.82),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under persisted search-workflow evidence captured from an earlier turn before the agent navigated away.',
                ],
                missing: [],
              };
            }

            if (
              !goalResult.achieved
              && shouldAcceptScriptBackedCompletion(
                scenario.goal,
                state,
                goalResult,
                action.result || '',
                verificationEvidence,
              )
            ) {
              goalResult = {
                ...goalResult,
                achieved: true,
                confidence: Math.max(goalResult.confidence, 0.8),
                evidence: [
                  ...goalResult.evidence,
                  'Accepted under script-backed extraction policy after supplemental tool evidence matched the claimed result.',
                ],
                missing: [],
              };
            }

            const contentTypeMismatch = detectCompletionContentTypeMismatch(
              scenario.goal,
              state,
              action.result || '',
              verificationEvidence,
            );
            if (contentTypeMismatch) {
              runState.verificationRejectionCount++;
              turn.verificationFailure = contentTypeMismatch;
              this.brain.injectFeedback(
                `COMPLETION REJECTED — content type mismatch.\n${contentTypeMismatch}\n` +
                'The goal has NOT been achieved yet. Continue working toward the requested content type.'
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue;
            }

            if (!goalResult.achieved) {
              // Progressive acceptance: after prior rejections, accept near-misses
              // rather than burning turns in verification loops.
              // Tier A: 1+ rejection + confidence ≥0.55 + supplemental evidence → accept
              // Tier B: 2+ rejections + confidence ≥0.50 → accept (agent has tried hard enough)
              // Tier C: 3+ rejections + confidence ≥0.40 → accept (prevent total turn exhaustion)
              const hasSupplementalEvidence = verificationEvidence.length > 0;
              const priorRejections = runState.verificationRejectionCount;
              const shouldAccept =
                (priorRejections >= 1 && goalResult.confidence >= 0.55 && hasSupplementalEvidence) ||
                (priorRejections >= 2 && goalResult.confidence >= 0.50) ||
                (priorRejections >= 3 && goalResult.confidence >= 0.40);
              if (shouldAccept) {
                goalResult = {
                  ...goalResult,
                  achieved: true,
                  confidence: goalResult.confidence,
                  evidence: [
                    ...goalResult.evidence,
                    `Accepted under progressive threshold after ${priorRejections} prior rejection(s)${hasSupplementalEvidence ? ' with supplemental evidence' : ''}.`,
                  ],
                  missing: [],
                };
              }
            }

            if (!goalResult.achieved) {
              runState.verificationRejectionCount++;
              turn.verificationFailure = goalResult.missing.join('; ') || 'Goal verification failed';
              runState.firstSufficientEvidenceTurn ??= i;

              // Gen 24b: checkpoint replay on 2nd rejection. Navigate back
              // to a previous page where the agent had correct data, instead
              // of continuing from the wrong-path state.
              let replayNote = '';
              if (runState.verificationRejectionCount === 2 && runState.checkpoints.length >= 2) {
                // Go back to the second-to-last checkpoint (before the wrong path)
                const target = runState.checkpoints[runState.checkpoints.length - 2];
                if (target) {
                  try {
                    await this.driver.execute({ action: 'navigate', url: target.url });
                    replayNote = ` ROLLED BACK to ${target.url} (checkpoint from turn ${target.turn}). You went down the wrong path — try a different approach from this known-good page.`;
                  } catch { /* rollback failed, continue from current state */ }
                }
              }

              // Gen 19: progressive strategy-shift escalation on rejection.
              let escalation: string;
              if (runState.verificationRejectionCount >= 3) {
                escalation = ' STRATEGY SHIFT REQUIRED: Your previous approaches have failed 3 times. Try a COMPLETELY different method: use navigate to go to a different search engine or URL, try extractWithIndex instead of runScript, or scroll to look for the data in a different part of the page. Do NOT repeat what you just tried.';
              } else if (runState.verificationRejectionCount >= 2) {
                escalation = ' Use runScript or extractWithIndex to extract the exact data from the page and include ALL required values in your completion result.';
              } else {
                escalation = ' Re-read the GOAL carefully — your result is missing specific data the goal asked for. Find and include it before completing.';
              }
              this.brain.injectFeedback(
                `REJECTED (${goalResult.confidence.toFixed(2)}). Missing: ${goalResult.missing.join('; ')}.${escalation}${replayNote}`
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue; // Don't complete — let agent iterate
            }
          }

          // Step 2: Quality gating (optional) — is the result good enough?
          const qualityThreshold = this.config.qualityThreshold ?? 0;
          if (qualityThreshold > 0) {
            const evaluation = await this.brain.evaluate(state, scenario.goal);

            if (evaluation.score < qualityThreshold) {
              if (this.config.debug) {
                console.log(`[Runner] Quality ${evaluation.score}/${qualityThreshold} — rejecting completion`);
              }
              runState.verificationRejectionCount++;
              runState.firstSufficientEvidenceTurn ??= i;
              this.brain.injectFeedback(
                `COMPLETION REJECTED — quality score ${evaluation.score}/10 is below threshold ${qualityThreshold}/10.\n` +
                `Issues: ${evaluation.issues.join(', ')}\n` +
                `Suggestions: ${evaluation.suggestions.join(', ')}\n` +
                `Please address these issues before completing.`
              );
              turn.durationMs = Date.now() - turnStart;
              turns.push(turn);
              this.onTurn?.(turn);
              continue;
            }

            // Both gates passed
            turns.push(turn);
            this.onTurn?.(turn);
            runState.firstSufficientEvidenceTurn ??= i;
            return buildResult({
              success: true,
              result: action.result,
              turns,
              totalMs: Date.now() - startTime,
              evaluation: {
                score: evaluation.score,
                assessment: evaluation.assessment,
                strengths: evaluation.strengths,
                issues: evaluation.issues,
                suggestions: evaluation.suggestions,
              },
              goalVerification: goalResult,
            });
          }

          // Goal verified (or skipped), no quality gate
          turns.push(turn);
          this.onTurn?.(turn);
          runState.firstSufficientEvidenceTurn ??= i;
          return buildResult({
            success: true,
            result: action.result,
            turns,
            totalMs: Date.now() - startTime,
            goalVerification: goalResult,
          });
        }

        if (action.action === 'abort') {
          turns.push(turn);
          this.onTurn?.(turn);
          return buildResult({
            success: false,
            reason: action.reason,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        const disallowedSearchClick = await this.inspectDisallowedSearchClick(state, scenario, action);
        if (disallowedSearchClick) {
          this.brain.injectFeedback(disallowedSearchClick);
          turn.error = disallowedSearchClick;
          turn.durationMs = Date.now() - turnStart;
          runState.recordError();
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 7. Execute (with stale-ref auto-retry) --
        // Wall-clock cap: entire execute chain (including overlay recovery and retries)
        // gets a hard 45s cap. Prevents heavy JS sites from consuming
        // the entire case budget on a single action (e.g., AliExpress 46s click
        // where withOverlayRecovery × withRetry multiplied a 22s timeout to 135s).
        const executeWallClockMs = 45_000;
        let execResult: Awaited<ReturnType<Driver['execute']>>;
        const executeStartedAt = Date.now();
        this.bus.emitNow({ type: 'execute-started', runId, turn: i, action });
        try {
          const executePromise = withRetry(
            () => this.driver.execute(action),
            retries,
            retryDelayMs,
            (attempt, err) => {
              if (this.config.debug) {
                console.log(`[Runner] Execute retry ${attempt}: ${err.message}`);
              }
            },
            scenario.signal,
          );
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Execute wall-clock timeout after ${executeWallClockMs}ms`)), executeWallClockMs),
          );
          execResult = await Promise.race([executePromise, timeoutPromise]);
          if (phaseTimings.firstExecuteMs === undefined) {
            phaseTimings.firstExecuteMs = Date.now() - executeStartedAt;
            this.onPhaseTiming?.('execute', phaseTimings.firstExecuteMs);
          }
          this.bus.emitNow({
            type: 'execute-completed',
            runId,
            turn: i,
            action,
            success: execResult.success,
            ...(execResult.error ? { error: execResult.error } : {}),
            ...(execResult.bounds ? { bounds: execResult.bounds } : {}),
            durationMs: Date.now() - executeStartedAt,
          });
        } catch (err) {
          this.bus.emitNow({
            type: 'execute-completed',
            runId,
            turn: i,
            action,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - executeStartedAt,
          });
          if (err instanceof StaleRefError) {
            // Stale ref — re-observe and cache for next turn (avoid double observe).
            // Only inject available refs, not the full snapshot — next turn's observe
            // provides the complete snapshot, so duplicating it here wastes 3-8k tokens.
            if (this.config.debug) {
              console.log(`[Runner] Stale ref @${err.staleRef} — re-observing for immediate retry`);
            }
            this.cachedPostState = await this.driver.observe();
            this.brain.injectFeedback(
              `Your selector @${err.staleRef} was not found. ` +
              `Available refs: ${err.availableRefs.slice(0, 20).join(', ')}. ` +
              `Pick a valid ref from the next observation.`
            );
            runState.recordError();
            turn.error = `Stale ref @${err.staleRef} — auto-retrying`;
            turn.durationMs = Date.now() - turnStart;
            turns.push(turn);
            this.onTurn?.(turn);
            continue;
          }

          // Execute wall-clock timeout: recover gracefully instead of aborting.
          // Heavy SPAs (AliExpress, AllTrails, SportingNews) can stall every action
          // for 45s+. Instead of counting these as consecutive errors (which aborts
          // after 3), re-observe and let the agent try a different approach.
          // Cap at 2 recoveries to prevent infinite timeout loops.
          if (
            err instanceof Error &&
            err.message.includes('Execute wall-clock timeout') &&
            executeTimeoutRecoveries < 2
          ) {
            executeTimeoutRecoveries++;
            if (this.config.debug) {
              console.log(`[Runner] Execute timeout recovery ${executeTimeoutRecoveries}/2 — re-observing`);
            }
            this.cachedPostState = await this.driver.observe().catch(() => undefined);
            this.brain.injectFeedback(
              'Your action timed out — the page is loading slowly or has heavy JavaScript. ' +
              'Try interacting with elements already visible in the snapshot, use runScript ' +
              'to extract data directly, or navigate to a different page.'
            );
            turn.error = `Execute timeout (recovered ${executeTimeoutRecoveries}/2)`;
            turn.durationMs = Date.now() - turnStart;
            turns.push(turn);
            this.onTurn?.(turn);
            continue;
          }

          throw err;
        }

        // Handle failed execution
        if (!execResult.success) {
          const errorMsg = execResult.error || 'Action execution failed';
          if (this.config.debug) {
            console.log(`[Runner] Action failed: ${errorMsg}`);
          }
          turn.error = errorMsg;
          runState.recordError();
        } else {
          runState.clearConsecutiveErrors();
          executeTimeoutRecoveries = 0; // Reset on successful action

          // Gen 27: surface form reset warnings from batch fill verification
          if ('warning' in execResult && typeof (execResult as { warning?: string }).warning === 'string') {
            const warning = (execResult as { warning: string }).warning;
            this.brain.injectFeedback(warning);
            if (this.config.debug) {
              console.log(`[Runner] Fill warning: ${warning}`);
            }
          }

          // Gen 24b: save checkpoint when URL changes after successful action.
          // These are rollback points for wrong-path recovery.
          const postUrl = this.driver.getPage?.()?.url() || '';
          const lastCheckpointUrl = runState.checkpoints[runState.checkpoints.length - 1]?.url;
          if (postUrl && postUrl !== 'about:blank' && postUrl !== lastCheckpointUrl) {
            runState.checkpoints.push({ url: postUrl, turn: i });
            // Keep max 5 checkpoints to avoid unbounded growth
            if (runState.checkpoints.length > 5) runState.checkpoints.shift();
          }

          // Capture element bounding box for replay overlays
          if (execResult.bounds) {
            turn.actionBounds = execResult.bounds;
          }

          // Update selector cache on successful action
          if (this.selectorCache && 'selector' in action && action.selector) {
            const element = findElementForRef(state.snapshot, action.selector);
            if (element) {
              this.selectorCache.recordSuccess(element, action.selector);
            }
          }
        }

        let followUpActions = this.selectFollowUpActions(action, nextActions);

        // Auto-submit: if we just typed into a searchbox and no follow-up
        // presses Enter or clicks a search button, inject a press Enter.
        // Many sites require form submission to trigger search filtering.
        if (
          !turn.error &&
          action.action === 'type' &&
          'selector' in action &&
          action.selector
        ) {
          const typedElement = findElementForRef(state.snapshot, action.selector)?.toLowerCase() ?? '';
          if (typedElement.startsWith('searchbox')) {
            const hasSubmit = followUpActions.some(
              (a) => (a.action === 'press' && 'key' in a && a.key === 'Enter') ||
                     (a.action === 'click' && 'selector' in a && a.selector &&
                       (findElementForRef(state.snapshot, a.selector)?.toLowerCase().includes('search') ?? false)),
            );
            if (!hasSubmit) {
              followUpActions = [{ action: 'press', selector: action.selector, key: 'Enter' }, ...followUpActions];
            }
          }
        }
        for (const followUpAction of followUpActions) {
          if (turn.error) break;
          try {
            const followResult = await withRetry(
              () => this.driver.execute(followUpAction),
              1, // Follow-ups are speculative micro-actions — fail fast, don't retry 3x
              retryDelayMs,
              (attempt, err) => {
                if (this.config.debug) {
                  console.log(`[Runner] Follow-up retry ${attempt}: ${err.message}`);
                }
              },
              scenario.signal,
            );
            executedActions.push(followUpAction);
            if (!followResult.success) {
              const followUpError = followResult.error || `Follow-up ${followUpAction.action} failed`;
              turn.error = followUpError;
              runState.recordError();
            }
          } catch (followErr) {
            turn.error = followErr instanceof Error ? followErr.message : String(followErr);
            runState.recordError();
          }
        }

        const domainBoundaryViolation = await this.enforceAllowedDomainBoundary(state, scenario);
        if (domainBoundaryViolation) {
          this.cachedPostState = undefined; // boundary navigated back — invalidate cache
          this.brain.injectFeedback(domainBoundaryViolation);
          turn.error = domainBoundaryViolation;
          turn.durationMs = Date.now() - turnStart;
          runState.recordError();
          if (executedActions.length > 1) {
            turn.executedActions = executedActions;
          }
          turns.push(turn);
          this.onTurn?.(turn);
          continue;
        }

        // -- 8. Post-action verification --
        if (expectedEffect && !turn.error) {
          const verifyStartedAt = Date.now();
          this.bus.emitNow({ type: 'verify-started', runId, turn: i, expectedEffect });
          const verifyResult = await this.verifyEffect(expectedEffect, state, action.action);
          turn.verified = verifyResult.verified;
          if (!verifyResult.verified) {
            turn.verificationFailure = verifyResult.reason;
            if (this.config.debug) {
              console.log(`[Runner] Verification failed: ${verifyResult.reason}`);
            }
          } else if (this.config.debug) {
            console.log(`[Runner] Verification passed`);
          }
          this.bus.emitNow({
            type: 'verify-completed',
            runId,
            turn: i,
            verified: verifyResult.verified,
            ...(verifyResult.reason ? { reason: verifyResult.reason } : {}),
            durationMs: Date.now() - verifyStartedAt,
          });
        } else if (
          !turn.error
          && !this.cachedPostState
          && (action.action === 'wait' || action.action === 'scroll')
          && executedActions.length === 1
        ) {
          // Pure wait/scroll with no expectedEffect: the ARIA tree didn't
          // structurally change. Reuse preActionState as the cached post-state
          // so the next loop iteration's observe is skipped. The driver's
          // refMap is still valid because no observe has reset it.
          this.cachedPostState = state;
        }

        if (executedActions.length > 1) {
          turn.executedActions = executedActions;
        }

        turn.durationMs = Date.now() - turnStart;
        turns.push(turn);
        this.onTurn?.(turn);
        this.bus.emitNow({ type: 'turn-completed', runId, turn: i, turnArtifact: turn });
        // Stash the expectedEffect so the NEXT turn's cache key includes it.
        // The post-action page state depends on what the agent claimed would
        // happen, so two turns with the same snapshot but different last
        // effects might warrant different decisions.
        lastEffectForCacheKey = expectedEffect ?? '';

      } catch (err) {
        runState.recordError();
        const error = err instanceof Error ? err.message : String(err);

        let timer: ReturnType<typeof setTimeout> | undefined;
        const emptyState: PageState = { url: '', title: '', snapshot: '' };
        // Suppress dangling rejection from the observe if the timeout wins
        const observePromise = this.driver.observe().catch(() => emptyState);
        const state = await Promise.race([
          observePromise,
          new Promise<PageState>((_, reject) => {
            timer = setTimeout(() => reject(new Error('observe timeout')), 5000);
          }),
        ]).catch(() => emptyState)
          .finally(() => { if (timer) clearTimeout(timer); });

        const turn: Turn = {
          turn: i,
          state,
          // Record as wait(0) — distinguishes crashes from intentional aborts
          action: { action: 'wait', ms: 0 },
          durationMs: Date.now() - turnStart,
          error,
        };

        turns.push(turn);
        this.onTurn?.(turn);

        if (runState.hasConsecutiveErrorThreshold) {
          return buildResult({
            success: false,
            reason: `${runState.consecutiveErrors} consecutive errors: ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (runState.isErrorBudgetExhausted) {
          return buildResult({
            success: false,
            reason: `Error budget exhausted (${runState.totalErrors}/${runState.maxTotalErrors} total errors): ${error}`,
            turns,
            totalMs: Date.now() - startTime,
          });
        }

        if (this.config.debug) {
          console.log(`[Runner] Error on turn ${i}, continuing: ${error}`);
        }
      }
    }

    // Max turns reached
    return buildResult({
      success: false,
      reason: `Max turns (${maxTurns}) reached`,
      turns,
      totalMs: Date.now() - startTime,
    });
  }

  private selectFollowUpActions(primaryAction: Action, nextActions?: Action[]): Action[] {
    const microPlanConfig = this.config.microPlan;
    if (microPlanConfig?.enabled !== true || !Array.isArray(nextActions) || nextActions.length === 0) {
      return [];
    }

    // Never chain follow-up actions behind terminal/meta actions.
    if (!SAFE_MICRO_ACTIONS.has(primaryAction.action)) {
      return [];
    }

    const limit = Math.max(
      1,
      Math.min(4, microPlanConfig.maxActionsPerTurn ?? DEFAULT_MICRO_PLAN_ACTIONS),
    );
    const remainingSlots = Math.max(0, limit - 1);
    if (remainingSlots === 0) return [];

    const selected: Action[] = [];
    for (const action of nextActions) {
      if (!SAFE_MICRO_ACTIONS.has(action.action)) continue;
      selected.push(action);
      if (selected.length >= remainingSlots) break;
    }
    return selected;
  }

  /** Persist knowledge, selector cache, and session history to disk */
  private saveMemory(scenario?: Scenario, result?: AgentResult, turns?: Turn[]): void {
    try {
      if (this.knowledge && scenario && result) {
        this.knowledge.recordSession(buildSession(scenario, result))

        // Gen 26b: extract reusable patterns from successful runs.
        // Patterns gain confidence with repeated observation and auto-decay
        // when contradicted. Low-confidence facts are pruned automatically.
        if (result.success && turns && turns.length > 0) {
          const domain = safeHostname(scenario.startUrl || '') || ''
          if (domain) {
            // Dynamic import to keep the module tree clean
            import('./pattern-extractor.js').then(({ extractPatterns, recordPatterns }) => {
              const patterns = extractPatterns(turns, domain, result.success)
              if (patterns.length > 0) {
                recordPatterns(this.knowledge!, patterns)
                this.knowledge!.save()
                if (this.config.debug) {
                  console.log(`[Runner] Recorded ${patterns.length} patterns for ${domain}`)
                }
              }
            }).catch(() => { /* pattern extraction is best-effort */ })
          }
        }
      }
      this.knowledge?.save();
      this.selectorCache?.save();
    } catch (err) {
      if (this.config.debug) {
        console.log(`[Runner] Failed to save memory: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Verify that an action had the expected effect.
   *
   * Uses a lightweight re-observe to check the page state after an action.
   * IMPORTANT: This calls observe() which resets the refMap. The runner
   * always calls observe() again at the start of the next turn, so this is safe.
   *
   * Checks common patterns:
   * - "URL should contain X" -> check page URL
   * - "element should be visible" -> check snapshot
   * - "text should appear" -> check snapshot
   * - Generic text match -> check if text appears in snapshot
   */
  /**
   * Gen 7: execute a Plan deterministically without re-entering the LLM
   * between steps. Each step:
   *   1. Drives the action via driver.execute (existing path, gets bus events)
   *   2. Verifies the post-condition via verifyExpectedEffect
   *   3. On success → advance to the next step
   *   4. On failure → bail and return the deviation context for the
   *      caller to inject into the per-action fallback loop
   *
   * Returns a structured summary so the caller can decide whether to
   * complete the run, fall back, or replan. Plan execution emits these
   * events on the bus:
   *   - plan-step-executed (per step, success or failure)
   *   - plan-deviated (on first failure)
   *
   * Plan steps are wrapped in Turn artifacts and pushed onto the same
   * `turns` array the per-action loop uses, so post-run analysis sees a
   * unified timeline. The Turn's `reasoning` field carries the plan
   * step's rationale, and `verified` carries the verification result.
   */
  private async executePlan(
    plan: Plan,
    scenario: Scenario,
    runId: string,
    turns: Turn[],
    runState: RunState,
    startingTurnIndex: number,
    /**
     * Token usage from the Brain.plan() LLM call that produced this plan.
     * The plan call's tokens are NOT attached to any per-step turn — there's
     * one plan call per N steps. To make the run-level cost tally honest,
     * we attribute the plan call to the FIRST step's Turn artifact so the
     * downstream sum (in baseline-summary.json / report.json) reflects the
     * real LLM spend. This was the metric bug that caused Gen 7.1 runs to
     * report $0 cost while Gen 7 baseline runs reported $0.50.
     */
    planCallTokens?: {
      tokensUsed?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    },
  ): Promise<
    | { kind: 'completed'; lastState: PageState; finalResult?: string; turnsConsumed: number }
    | { kind: 'deviated'; lastState: PageState; failedStepIndex: number; reason: string; turnsConsumed: number }
  > {
    let currentTurnIndex = startingTurnIndex
    let lastState: PageState = turns[turns.length - 1]?.state
      ?? { url: '', title: '', snapshot: '' }

    // Gen 7.2: track the last successful `runScript` output across plan steps
    // so a downstream `complete` step with placeholder values (null,
    // "<from prior step>", etc.) can be substituted with the real script
    // output. The planner has to commit to its `complete.result` text BEFORE
    // runScript runs, so on extraction tasks it fabricates placeholders.
    // This deterministic substitution fixes that without an extra LLM call.
    let lastRunScriptOutput: string | null = null

    // Gen 10: track the last extractWithIndex match list. Unlike runScript,
    // we do NOT auto-substitute this into a placeholder complete — the LLM
    // must read the formatted match list and pick by index. When the plan
    // ends with extractWithIndex (or runs out of valid steps), we fall
    // through to the per-action loop with the match list as feedback.
    let lastExtractOutput: string | null = null

    for (let stepIdx = 0; stepIdx < plan.steps.length; stepIdx++) {
      if (scenario.signal?.aborted) {
        return {
          kind: 'deviated',
          lastState,
          failedStepIndex: stepIdx,
          reason: scenario.signal.reason || 'Cancelled',
          turnsConsumed: stepIdx,
        }
      }

      const step = plan.steps[stepIdx]
      const stepStartedAt = Date.now()
      const turnNumber = currentTurnIndex + 1
      currentTurnIndex++

      // Refresh the snapshot before EVERY step. The plan was built from a
      // single observe() call at turn 1; later steps may target a different
      // page entirely (after navigate / click "Next"). The first observe
      // here is also what verify-against will eventually consume.
      const preStepState = await this.driver.observe().catch(() => lastState)
      lastState = preStepState

      // Wrap each plan step in a Turn artifact so post-run analysis (the
      // viewer, the events.jsonl persistence, the metrics) sees a unified
      // timeline regardless of whether the runner used the planner or the
      // per-action loop.
      //
      // Token attribution: the FIRST step of each plan carries the
      // Brain.plan() LLM call's token usage. Without this, runs that stay
      // in plan-mode (Gen 7.1) report $0 cost while their Brain.plan()
      // calls actually spent real tokens.
      const isFirstStep = stepIdx === 0
      const turn: Turn = {
        turn: turnNumber,
        state: preStepState,
        action: step.action,
        reasoning: step.rationale ?? `Plan step ${stepIdx + 1}/${plan.steps.length}`,
        expectedEffect: step.expectedEffect,
        plan: plan.steps.map((s) => s.rationale ?? s.action.action),
        currentStep: stepIdx,
        durationMs: 0,
        ...(isFirstStep && planCallTokens?.tokensUsed !== undefined ? { tokensUsed: planCallTokens.tokensUsed } : {}),
        ...(isFirstStep && planCallTokens?.inputTokens !== undefined ? { inputTokens: planCallTokens.inputTokens } : {}),
        ...(isFirstStep && planCallTokens?.outputTokens !== undefined ? { outputTokens: planCallTokens.outputTokens } : {}),
        ...(isFirstStep && planCallTokens?.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: planCallTokens.cacheReadInputTokens } : {}),
        ...(isFirstStep && planCallTokens?.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: planCallTokens.cacheCreationInputTokens } : {}),
      }

      // Terminal actions: complete and abort don't go through driver.execute
      // — the runner handles them as the end of the plan.
      if (step.action.action === 'complete') {
        // Gen 7.2 placeholder substitution: if the planner emitted a complete
        // with placeholder values AND we have a real runScript output from
        // earlier in the plan, use the runScript output as the final result.
        // Detection is conservative: only substitute when the planner clearly
        // didn't know real values at planning time (null literals, "<from
        // prior step>", "{{...}}" templates, "<placeholder>", etc.).
        let resolvedResult = step.action.result
        if (
          lastRunScriptOutput
          && typeof resolvedResult === 'string'
          && hasPlaceholderPattern(resolvedResult)
        ) {
          if (this.config.debug) {
            console.log(`[Runner] Gen 7.2: substituting placeholder complete.result with runScript output (${lastRunScriptOutput.length} chars)`)
          }
          resolvedResult = lastRunScriptOutput
          turn.reasoning = `${turn.reasoning ?? ''} [Gen 7.2 substituted runScript output]`.trim()
        }
        turn.durationMs = Date.now() - stepStartedAt
        turns.push(turn)
        this.onTurn?.(turn)
        this.bus.emitNow({
          type: 'plan-step-executed',
          runId,
          turn: turnNumber,
          stepIndex: stepIdx + 1,
          totalSteps: plan.steps.length,
          action: step.action,
          executeSuccess: true,
          verified: true,
          durationMs: turn.durationMs,
        })
        return {
          kind: 'completed',
          lastState,
          finalResult: resolvedResult,
          turnsConsumed: stepIdx + 1,
        }
      }
      if (step.action.action === 'abort') {
        turn.durationMs = Date.now() - stepStartedAt
        turns.push(turn)
        this.onTurn?.(turn)
        this.bus.emitNow({
          type: 'plan-deviated',
          runId,
          turn: turnNumber,
          stepIndex: stepIdx + 1,
          totalSteps: plan.steps.length,
          reason: `plan aborted: ${step.action.reason}`,
        })
        return {
          kind: 'deviated',
          lastState,
          failedStepIndex: stepIdx,
          reason: `plan aborted: ${step.action.reason}`,
          turnsConsumed: stepIdx + 1,
        }
      }

      // Execute the action via the existing driver path. This emits
      // execute-started / execute-completed events on the bus exactly
      // like the per-action loop does.
      //
      // CRITICAL: each plan step gets a 10s wall-clock cap (vs the driver's
      // default 30s). Plan steps assume every selector was just observed in
      // the snapshot at planning time — a missing element should fail
      // FAST and trigger fallback to per-action mode, NOT block the run for
      // 30s. Batch verbs already enforce a 5s per-field cap internally,
      // but single-step type/click/press/select use the full 30s default.
      this.bus.emitNow({ type: 'execute-started', runId, turn: turnNumber, action: step.action })
      const execStartedAt = Date.now()
      const planStepTimeoutMs = 10_000
      let execResult: Awaited<ReturnType<Driver['execute']>>
      try {
        execResult = await Promise.race([
          this.driver.execute(step.action),
          new Promise<Awaited<ReturnType<Driver['execute']>>>((resolve) =>
            setTimeout(
              () => resolve({ success: false, error: `plan step wall-clock timeout after ${planStepTimeoutMs}ms` }),
              planStepTimeoutMs,
            ),
          ),
        ])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        execResult = { success: false, error: message }
      }
      const execDurationMs = Date.now() - execStartedAt
      this.bus.emitNow({
        type: 'execute-completed',
        runId,
        turn: turnNumber,
        action: step.action,
        success: execResult.success,
        ...(execResult.error ? { error: execResult.error } : {}),
        ...(execResult.bounds ? { bounds: execResult.bounds } : {}),
        durationMs: execDurationMs,
      })

      if (!execResult.success) {
        turn.error = execResult.error
        turn.durationMs = Date.now() - stepStartedAt
        turn.verified = false
        turn.verificationFailure = `execute failed: ${execResult.error}`
        turns.push(turn)
        this.onTurn?.(turn)
        runState.recordError()
        this.bus.emitNow({
          type: 'plan-step-executed',
          runId,
          turn: turnNumber,
          stepIndex: stepIdx + 1,
          totalSteps: plan.steps.length,
          action: step.action,
          executeSuccess: false,
          verified: false,
          durationMs: Date.now() - stepStartedAt,
          ...(execResult.error ? { verifyReason: execResult.error } : {}),
        })
        this.bus.emitNow({
          type: 'plan-deviated',
          runId,
          turn: turnNumber,
          stepIndex: stepIdx + 1,
          totalSteps: plan.steps.length,
          reason: `execute failed: ${execResult.error}`,
        })
        return {
          kind: 'deviated',
          lastState,
          failedStepIndex: stepIdx,
          reason: `execute failed at step ${stepIdx + 1}: ${execResult.error}`,
          turnsConsumed: stepIdx + 1,
        }
      }

      runState.clearConsecutiveErrors()
      if (execResult.bounds) turn.actionBounds = execResult.bounds

      // Gen 7.2: capture runScript output so a downstream complete step
      // with placeholder values can be substituted with the real output.
      // This is the supply side of the placeholder-substitution fix above.
      if (step.action.action === 'runScript' && typeof execResult.data === 'string' && execResult.data.length > 0) {
        lastRunScriptOutput = execResult.data
        if (execResult.data.length > 10) {
          runState.recordEvidence(`EXTRACTED (turn ${currentTurnIndex}): ${execResult.data.slice(0, 500)}`)
        }
      }

      // Gen 10: capture extractWithIndex match list for fall-through to the
      // per-action loop. The LLM must read the list and pick by index — we
      // do not auto-complete with the raw match list.
      if (step.action.action === 'extractWithIndex' && typeof execResult.data === 'string' && execResult.data.length > 0) {
        lastExtractOutput = execResult.data
        // Also push as goal verification evidence so the verifier sees what
        // the agent extracted.
        runState.firstSufficientEvidenceTurn ??= currentTurnIndex
        pushGoalVerificationEvidence(runState.goalVerificationEvidence, `EXTRACT RESULT:\n${execResult.data}`)
        if (execResult.data.length > 10) {
          runState.recordEvidence(`EXTRACTED (turn ${currentTurnIndex}): ${execResult.data.slice(0, 500)}`)
        }
      }

      // Verify the post-condition. We re-observe to get the post-action
      // state, then run the same verifyExpectedEffect helper the per-action
      // loop uses. The fresh observe is also stashed in cachedPostState so
      // the next step's pre-step observe is short-circuited (Gen 4 lazy
      // observe optimization).
      this.bus.emitNow({
        type: 'verify-started',
        runId,
        turn: turnNumber,
        expectedEffect: step.expectedEffect,
      })
      const verifyStartedAt = Date.now()
      // Auto-pass list — these actions either don't observably mutate
      // the page state OR they're self-verifying (the underlying Playwright
      // call throws on real failure, so a successful return means the
      // mutation actually happened). Strict expectedEffect verification
      // would generate false negatives on the per-action loop fallback for
      // these. Plan execution trusts the execute result.
      //
      // - wait / scroll / hover: don't mutate observable snapshot state
      // - runScript / evaluate / verifyPreview: meta actions
      // - fill / clickSequence: self-verifying (Playwright throws on miss),
      //   AND input values don't always reflect in the ARIA snapshot, so
      //   the permissive "did state change?" check would also miss them
      const isAutoPass =
        step.action.action === 'wait'
        || step.action.action === 'scroll'
        || step.action.action === 'hover'
        || step.action.action === 'runScript'
        || step.action.action === 'extractWithIndex'
        || step.action.action === 'evaluate'
        || step.action.action === 'verifyPreview'
        || step.action.action === 'fill'
        || step.action.action === 'clickSequence'
      // Settle wait for mutating actions, mirroring verifyEffect's logic
      const needsSettleWait = step.action.action === 'click'
        || step.action.action === 'navigate'
        || step.action.action === 'press'
        || step.action.action === 'select'
        || step.action.action === 'fill'
        || step.action.action === 'clickSequence'
      const observePromise = this.driver.observe().catch(() => preStepState)
      if (needsSettleWait) {
        await Promise.all([
          observePromise,
          new Promise((r) => setTimeout(r, 50)),
        ])
      }
      const postStepState = await observePromise
      this.cachedPostState = postStepState
      lastState = postStepState

      // Plan verification is more permissive than per-action verification:
      // a step passes if (a) it's a non-mutating action, OR (b) the strict
      // verifier passes, OR (c) the snapshot/url changed in any meaningful
      // way (the action did SOMETHING). Strict failure-on-no-change is
      // appropriate for the per-action loop where the agent can recover,
      // but plan execution needs to push forward unless there's positive
      // evidence of failure.
      let verifyResult: { verified: boolean; reason?: string }
      if (isAutoPass) {
        verifyResult = { verified: true }
      } else {
        const strictResult = verifyExpectedEffect({
          expectedEffect: step.expectedEffect,
          preActionState: preStepState,
          postActionState: postStepState,
        })
        if (strictResult.verified) {
          verifyResult = strictResult
        } else {
          // Permissive fallback: did the page change at all?
          const stateChanged =
            preStepState.url !== postStepState.url
            || preStepState.title !== postStepState.title
            || preStepState.snapshot !== postStepState.snapshot
          if (stateChanged) {
            verifyResult = { verified: true }
          } else {
            verifyResult = strictResult
          }
        }
      }
      turn.verified = verifyResult.verified
      if (!verifyResult.verified) {
        turn.verificationFailure = verifyResult.reason
      }
      turn.durationMs = Date.now() - stepStartedAt
      turns.push(turn)
      this.onTurn?.(turn)

      this.bus.emitNow({
        type: 'verify-completed',
        runId,
        turn: turnNumber,
        verified: verifyResult.verified,
        ...(verifyResult.reason ? { reason: verifyResult.reason } : {}),
        durationMs: Date.now() - verifyStartedAt,
      })
      this.bus.emitNow({
        type: 'plan-step-executed',
        runId,
        turn: turnNumber,
        stepIndex: stepIdx + 1,
        totalSteps: plan.steps.length,
        action: step.action,
        executeSuccess: true,
        verified: verifyResult.verified,
        durationMs: Date.now() - stepStartedAt,
        ...(verifyResult.reason ? { verifyReason: verifyResult.reason } : {}),
      })

      if (!verifyResult.verified) {
        this.bus.emitNow({
          type: 'plan-deviated',
          runId,
          turn: turnNumber,
          stepIndex: stepIdx + 1,
          totalSteps: plan.steps.length,
          reason: `verification failed at step ${stepIdx + 1}: ${verifyResult.reason ?? 'expected effect not observed'}`,
        })
        return {
          kind: 'deviated',
          lastState,
          failedStepIndex: stepIdx,
          reason: `verification failed at step ${stepIdx + 1}: ${verifyResult.reason ?? 'expected effect not observed'}`,
          turnsConsumed: stepIdx + 1,
        }
      }
    }

    // Gen 7.2 auto-complete-from-runScript: if the plan ended without an
    // explicit complete BUT the last successful step was a runScript with
    // non-empty output, treat the runScript output as the final result and
    // synthesize a complete turn. This handles the planner-prompt path where
    // the planner correctly emits ONLY runScript on extraction tasks (per
    // rule #7) — without this, we'd fall through to a 4-5 turn per-action
    // loop that's much slower than necessary.
    //
    // Detection: the LAST step in the plan was a `runScript` AND we captured
    // a non-empty output for it. We don't check intermediate steps because
    // a plan like [navigate, click, runScript] where runScript is last is
    // exactly the extraction-task shape we want to short-circuit.
    const lastStep = plan.steps[plan.steps.length - 1]
    if (
      lastStep
      && lastStep.action.action === 'runScript'
      && isMeaningfulRunScriptOutput(lastRunScriptOutput)
    ) {
      const synthTurnNumber = currentTurnIndex + 1
      const synthTurn: Turn = {
        turn: synthTurnNumber,
        state: lastState,
        action: { action: 'complete', result: lastRunScriptOutput! },
        reasoning: 'Gen 7.2 auto-complete: plan ended after runScript, runner emitted complete with the runScript output',
        durationMs: 0,
      }
      turns.push(synthTurn)
      this.onTurn?.(synthTurn)
      this.bus.emitNow({
        type: 'plan-step-executed',
        runId,
        turn: synthTurnNumber,
        stepIndex: plan.steps.length + 1,
        totalSteps: plan.steps.length + 1,
        action: synthTurn.action,
        executeSuccess: true,
        verified: true,
        durationMs: 0,
      })
      if (this.config.debug) {
        console.log(`[Runner] Gen 7.2: auto-emitted complete with runScript output (${lastRunScriptOutput!.length} chars) after plan exhausted`)
      }
      return {
        kind: 'completed',
        lastState,
        finalResult: lastRunScriptOutput!,
        turnsConsumed: plan.steps.length + 1,
      }
    }

    // Gen 10: if the plan ended with extractWithIndex, fall through to the
    // per-action loop with the match list as feedback. The LLM must read
    // the matches and pick by index — we do NOT auto-complete with the raw
    // match list. This is the planner-emits-extract path for extraction
    // tasks like npm/mdn/python-docs where the planner used the new
    // extractWithIndex action.
    if (lastExtractOutput) {
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: plan.steps.length,
        reason: `plan completed extractWithIndex but the LLM must read the matches and pick by index. Match list:\n${lastExtractOutput.slice(0, 4000)}\n\nPick the index whose text matches the goal, then emit complete with result: <picked text>`,
        turnsConsumed: plan.steps.length,
      }
    }

    // Gen 9 (cherry-picked into Gen 10): if the last step WAS a runScript
    // but the output was NOT meaningful (null, empty, placeholder), DO NOT
    // auto-complete with garbage. Fall through to the per-action loop with
    // a deviation reason that names the empty output. In Gen 10 the per-
    // action loop has TWO new tools that make this recovery actually work:
    //   1. extractWithIndex (the wide-query content-match action) — see
    //      data-extraction rule #25
    //   2. cost cap (100k tokens) — bounds any death-spiral if the LLM
    //      can't recover, preventing the Gen 9.1 reddit failure mode
    if (
      lastStep
      && lastStep.action.action === 'runScript'
      && !isMeaningfulRunScriptOutput(lastRunScriptOutput)
    ) {
      if (this.config.debug) {
        console.log(`[Runner] Gen 9: runScript returned no meaningful output (${JSON.stringify(lastRunScriptOutput).slice(0, 100)}); falling through to per-action loop for two-pass extraction`)
      }
      return {
        kind: 'deviated',
        lastState,
        failedStepIndex: plan.steps.length - 1,
        reason: `runScript returned no meaningful output (got: ${JSON.stringify(lastRunScriptOutput).slice(0, 200)}). The first-pass extraction failed — re-observe the page and try extractWithIndex with a wide query (e.g. 'p, span, dd, code') and a contains filter naming the expected text fragment. Pick-by-content beats pick-by-selector when the planner couldn't see the data at plan time.`,
        turnsConsumed: plan.steps.length,
      }
    }

    // All steps verified BUT the plan ended without an explicit complete/abort.
    // This means the planner emitted a finite sequence of "work" steps and
    // didn't terminate. The right behavior is NOT to fabricate a complete —
    // we treat plan exhaustion as a deviation that triggers fallback to the
    // per-action loop. The per-action loop will continue from the current
    // state and emit `complete` when the goal is genuinely met.
    return {
      kind: 'deviated',
      lastState,
      failedStepIndex: plan.steps.length,
      reason: 'plan exhausted without an explicit complete or abort step — falling through to per-action loop to finish the task',
      turnsConsumed: plan.steps.length,
    }
  }

  private async verifyEffect(
    expectedEffect: string,
    preActionState: PageState,
    actionType?: Action['action'],
  ): Promise<{ verified: boolean; reason?: string }> {
    // Only pause for actions that mutate the page in flight (navigation,
    // clicks that may trigger XHR/route transitions, form submits). For
    // pure reads, scrolls, hovers, and waits the page state is already
    // settled by the time execute returns. The previous unconditional
    // 100ms wait was pure dead time on every turn.
    const needsSettleWait = actionType === 'click'
      || actionType === 'navigate'
      || actionType === 'press'
      || actionType === 'select';
    // Kick observe off immediately and let the settle wait race against it.
    // observe() polls waitForLoadState internally, so the 50ms settle is
    // really only there to let click handlers schedule their first XHR; we
    // don't need to *block* on it before starting observe.
    const observePromise = this.driver.observe().catch(() => preActionState);
    if (needsSettleWait) {
      await Promise.all([
        observePromise,
        new Promise(r => setTimeout(r, 50)),
      ]);
    }
    const postState = await observePromise;
    this.cachedPostState = postState;
    return verifyExpectedEffect({
      expectedEffect,
      preActionState,
      postActionState: postState,
    });
  }

  private async buildSearchResultsScoutFeedback(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
    seenUrls: Set<string>,
  ): Promise<string> {
    if (!buildSearchResultsGuidance(state, goal, allowedDomains)) return '';
    if (seenUrls.has(state.url)) return '';

    const page = this.driver.getPage?.();
    if (!page) return '';

    try {
      const candidates = await page.evaluate(() => {
        const items: Array<{ title: string; href: string }> = [];
        const seen = new Set<string>();
        const selectors = [
          'main a[href]',
          '[role="main"] a[href]',
          'article a[href]',
          '.search-results a[href]',
          '#search-results a[href]',
          '.results a[href]',
          'ol a[href]',
        ];
        const fallbackLinks = Array.from(document.querySelectorAll('a[href]'));
        const links = selectors
          .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .concat(fallbackLinks);
        const noisePattern = /\b(next|previous|page \d+|show more|show fewer|filter|sort|home|contact|privacy|accessibility|search)\b/i;

        for (const node of links) {
          const anchor = node as HTMLAnchorElement;
          const href = anchor.href?.trim();
          const title = (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim();
          if (!href || !title || title.length < 12 || title.length > 220) continue;
          if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.includes('#')) continue;
          if (href.includes('results.aspx') && !/open government|dataset|data|news release|press release/i.test(title)) continue;
          if (noisePattern.test(title) && !/open government|dataset|data|news release|press release/i.test(title)) continue;
          const key = `${title}::${href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ title, href });
          if (items.length >= 24) break;
        }
        return items;
      });

      if (!Array.isArray(candidates) || candidates.length === 0) return '';
      const ranked = rankSearchCandidates(goal, candidates, allowedDomains);
      const recommendation = ranked[0];
      seenUrls.add(state.url);
      return [
        'SEARCH RESULTS CANDIDATES:',
        ...ranked.map((candidate, index) => `${index + 1}. ${candidate.title} — ${candidate.href} (score ${candidate.score})`),
        recommendation
          ? `BEST MATCH RECOMMENDATION: prefer "${recommendation.title}" because it best matches the requested entity, content type, and host constraints.`
          : '',
      ].join('\n');
    } catch {
      return '';
    }
  }

  private async buildVisibleLinkScoutRecommendation(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
  ): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
    const scoutConfig = this.config.scout;
    if (!scoutConfig?.enabled) return undefined;
    if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

    const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
    const maxCandidates = Math.max(2, Math.min(scoutConfig.maxCandidates ?? 3, 5));
    const candidates = await this.filterScoutCandidatesByAllowedDomains(
      ranked.slice(0, maxCandidates),
      allowedDomains,
    );
    if (!shouldUseVisibleLinkScout(candidates, scoutConfig)) return undefined;

    const scoutState = scoutConfig.useVision
      ? await this.attachDecisionScreenshot(state)
      : state;
    const extraContext = allowedDomains && allowedDomains.length > 0
      ? `Host constraint: prefer only ${allowedDomains.join(', ')}.`
      : undefined;
    const recommendation = await this.brain.recommendLinkCandidate(
      goal,
      scoutState,
      candidates,
      extraContext,
    );
    const matched = candidates.find((candidate) => candidate.ref === recommendation.selector);
    if (!matched) return undefined;

    return {
      ref: matched.ref,
      text: matched.text,
      confidence: recommendation.confidence,
      reasoning: recommendation.reasoning,
    };
  }

  private async buildBranchLinkRecommendation(
    state: PageState,
    goal: string,
    allowedDomains: string[] | undefined,
  ): Promise<{ ref: string; text: string; confidence: number; reasoning: string } | undefined> {
    const scoutConfig = this.config.scout;
    if (!scoutConfig?.enabled || !scoutConfig.readOnlyTop2Challenger) return undefined;
    if (!shouldUseVisibleLinkScoutPage(state, goal, allowedDomains)) return undefined;

    const ranked = getRankedVisibleLinkCandidates(state, goal, allowedDomains);
    const candidates = ranked.slice(0, 2);
    if (!shouldUseBoundedBranchExplorer(candidates, scoutConfig)) return undefined;
    if (!this.driver.inspectSelectorHref || !this.driver.getPage) return undefined;

    const page = this.driver.getPage();
    if (!page) return undefined;

    const settled = await Promise.all(
      candidates.map(async (candidate) => {
        const href = await this.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
        if (!href) return undefined;
        const preview = await inspectBranchPreview(page, href, 8000);
        if (!preview) return undefined;
        return { ref: candidate.ref, text: candidate.text, href, score: scoreBranchPreview(goal, preview, allowedDomains), preview };
      }),
    );
    const previews = settled.filter(
      (r): r is { ref: string; text: string; href: string; score: number; preview: BranchPreview } => r !== undefined,
    );

    if (previews.length < 2) return undefined;
    previews.sort((a, b) => b.score - a.score);
    const [top, second] = previews;
    if (top.score <= second.score) return undefined;
    if (top.score < 4) return undefined;

    return {
      ref: top.ref,
      text: top.text,
      confidence: Math.min(0.95, 0.7 + Math.max(0, top.score - second.score) / 20),
      reasoning: `Branch preview favored ${top.href} (${top.preview.title || top.preview.finalUrl}) over ${second.href} based on content-type and goal-match signals.`,
    };
  }

  private async filterScoutCandidatesByAllowedDomains(
    candidates: Array<{ ref: string; text: string; score: number }>,
    allowedDomains: string[] | undefined,
  ): Promise<Array<{ ref: string; text: string; score: number }>> {
    if (!allowedDomains || allowedDomains.length === 0 || !this.driver.inspectSelectorHref) {
      return candidates;
    }

    const allowedHosts = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
    const resolved = await Promise.all(
      candidates.map(async (candidate) => {
        const href = await this.driver.inspectSelectorHref!(candidate.ref).catch(() => undefined);
        const host = href ? safeHostname(href) : undefined;
        return { candidate, host };
      }),
    );
    return resolved
      .filter(({ host }) => !host || allowedHosts.has(host))
      .map(({ candidate }) => candidate);
  }

  private async inspectDisallowedSearchClick(
    state: PageState,
    scenario: Scenario,
    action: Action,
  ): Promise<string | undefined> {
    if (action.action !== 'click') return undefined;
    if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;
    if (!buildSearchResultsGuidance(state, scenario.goal, scenario.allowedDomains)) return undefined;
    if (!this.driver.inspectSelectorHref) return undefined;

    const href = await this.driver.inspectSelectorHref(action.selector);
    const host = href ? safeHostname(href) : undefined;
    if (!href || !host) return undefined;
    const allowedLower = scenario.allowedDomains.map((domain) => domain.toLowerCase());
    if (allowedLower.includes(host)) return undefined;
    // First-party subdomain tolerance
    const toRoot = (h: string) => {
      const parts = h.split('.').filter(Boolean);
      return parts.length <= 2 ? h : parts.slice(-2).join('.');
    };
    if (allowedLower.some((h) => toRoot(h) === toRoot(host))) return undefined;

    return [
      `Blocked action: selector ${action.selector} resolves to ${href}, which is outside the allowed host set: ${scenario.allowedDomains.join(', ')}.`,
      'Choose a result from an allowed host instead, even if the snippet text looks relevant.',
    ].join(' ');
  }

  private async enforceAllowedDomainBoundary(
    preActionState: PageState,
    scenario: Scenario,
  ): Promise<string | undefined> {
    if (!scenario.allowedDomains || scenario.allowedDomains.length === 0) return undefined;

    const currentUrl = this.driver.getUrl?.() ?? preActionState.url;
    const currentHost = safeHostname(currentUrl);
    if (!currentHost) return undefined;

    const allowedHosts = scenario.allowedDomains.map((domain) => domain.toLowerCase());
    if (allowedHosts.includes(currentHost)) return undefined;

    // First-party subdomain tolerance: allow navigation within the same registrable domain
    const toRoot = (h: string) => {
      const parts = h.split('.').filter(Boolean);
      return parts.length <= 2 ? h : parts.slice(-2).join('.');
    };
    const currentRoot = toRoot(currentHost);
    if (allowedHosts.some((h) => toRoot(h) === currentRoot)) return undefined;

    const previousHost = safeHostname(preActionState.url);
    if (previousHost && allowedHosts.includes(previousHost)) {
      await this.driver.execute({ action: 'navigate', url: preActionState.url }).catch(() => {});
    } else if (scenario.startUrl) {
      await this.driver.execute({ action: 'navigate', url: scenario.startUrl }).catch(() => {});
    }

    return [
      `Boundary violation: landed on ${currentUrl}, but the allowed host set is ${allowedHosts.join(', ')}.`,
      'Return to an allowed host and continue from there; do not rely on disallowed subdomains even if their snippet looks relevant.',
    ].join(' ');
  }

  private async attachDecisionScreenshot(state: PageState): Promise<PageState> {
    if (state.screenshot || !this.driver.screenshot) return state;
    try {
      const screenshot = await this.driver.screenshot();
      return { ...state, screenshot: screenshot.toString('base64') };
    } catch {
      return state;
    }
  }
}

/** Convenience function */
export async function runBrowserAgent(
  driver: Driver,
  scenario: Scenario,
  options?: Omit<BrowserAgentOptions, 'driver'>
): Promise<AgentResult> {
  const runner = new BrowserAgent({ driver, ...options });
  return runner.run(scenario);
}
