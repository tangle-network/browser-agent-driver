import type { Action, AgentConfig, Turn } from '../types.js';
import { calculateCost } from '../model-pricing.js';
import {
  getTelemetry,
  shortHash,
  type TelemetryClient,
  type TelemetryModel,
} from '../telemetry/index.js';
import type { TurnEvent, TurnEventBus } from './events.js';

const MAX_PREVIEW_CHARS = 240;

export interface TurnEventTelemetryOptions {
  config?: AgentConfig;
  model?: TelemetryModel;
  telemetry?: TelemetryClient;
}

interface RunTelemetrySummary {
  eventCount: number;
  modelCallCount: number;
  toolCallCount: number;
  screenshotCount: number;
  executeFailureCount: number;
  verificationRejectionCount: number;
  recoveryCount: number;
  overrideCount: number;
  planDeviationCount: number;
  planFallbackCount: number;
  planStepCount: number;
  planStepFailureCount: number;
  decideCacheHits: number;
  decidePatternSkips: number;
  usageReportedCount: number;
  missingUsageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCostUsd: number;
  snapshotBytes: number;
  screenshotBytes: number;
  completedTurns: number;
  maxTurns?: number;
  goalHash?: string;
  goalLength?: number;
  startUrl?: string;
  eventCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  modelCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  phaseDurationsMs: Record<string, number>;
  emittedRunSummary: boolean;
}

export function attachTurnEventTelemetry(
  bus: TurnEventBus,
  options: TurnEventTelemetryOptions = {},
): () => void {
  const telemetry = options.telemetry ?? getTelemetry();
  const fallbackModel = options.model ?? modelFromConfig(options.config);
  const summary = createRunTelemetrySummary();

  return bus.subscribe((event) => {
    emitTurnEventTelemetry(event, telemetry, fallbackModel);
    recordRunTelemetrySummary(summary, event, fallbackModel);
    if (event.type === 'run-completed' && !summary.emittedRunSummary) {
      emitRunTelemetrySummary(summary, event, telemetry, fallbackModel);
      summary.emittedRunSummary = true;
    }
  }, false);
}

function emitTurnEventTelemetry(
  event: TurnEvent,
  telemetry: TelemetryClient,
  fallbackModel?: TelemetryModel,
): void {
  const phase = phaseForEvent(event);
  const model = modelForEvent(event, fallbackModel);
  const metrics = metricsForEvent(event, model);
  const data = dataForEvent(event, phase);
  const error = errorForEvent(event);

  telemetry.emit({
    kind: 'agent-step',
    runId: event.runId,
    ok: okForEvent(event),
    durationMs: durationForEvent(event),
    data,
    metrics,
    tags: {
      eventType: event.type,
      phase,
      status: statusForEvent(event),
    },
    ...(model ? { model } : {}),
    ...(error ? { error } : {}),
  });
}

function phaseForEvent(event: TurnEvent): string {
  if (event.type.startsWith('run-')) return 'run';
  if (event.type.startsWith('turn-')) return 'turn';
  if (event.type.startsWith('observe-')) return 'observe';
  if (event.type.startsWith('decide-')) return 'decide';
  if (event.type.startsWith('execute-')) return 'execute';
  if (event.type.startsWith('verify-')) return 'verify';
  if (event.type.startsWith('plan-')) return 'plan';
  if (event.type === 'recovery-fired') return 'recovery';
  if (event.type === 'override-applied') return 'override';
  return 'unknown';
}

function statusForEvent(event: TurnEvent): string {
  if (event.type.endsWith('-started')) return 'started';
  if (event.type.includes('-skipped-')) return 'skipped';
  if (event.type === 'decide-token') return 'streaming';
  if (event.type === 'plan-deviated') return 'deviated';
  if (event.type === 'plan-fallback-entered') return 'fallback';
  if (event.type === 'recovery-fired') return 'recovery';
  if (event.type === 'override-applied') return 'override';
  if (event.type === 'verify-completed') return event.verified ? 'verified' : 'rejected';
  if (event.type === 'execute-completed') return event.success ? 'completed' : 'failed';
  if (event.type === 'plan-completed') {
    if (event.parseError || !event.plan || event.stepCount === 0) return 'failed';
    return 'completed';
  }
  if (event.type === 'plan-step-executed') {
    if (!event.executeSuccess) return 'failed';
    return event.verified ? 'completed' : 'rejected';
  }
  if (event.type === 'run-completed') return event.success ? 'completed' : 'failed';
  if (event.type.endsWith('-completed')) return 'completed';
  return 'event';
}

function okForEvent(event: TurnEvent): boolean {
  if (event.type === 'execute-completed') return event.success;
  if (event.type === 'verify-completed') return event.verified;
  if (event.type === 'run-completed') return event.success;
  if (event.type === 'plan-deviated') return false;
  if (event.type === 'plan-completed') return !event.parseError && !!event.plan && event.stepCount > 0;
  if (event.type === 'plan-step-executed') return event.executeSuccess && event.verified;
  return true;
}

function durationForEvent(event: TurnEvent): number {
  if ('durationMs' in event && typeof event.durationMs === 'number') return event.durationMs;
  if (event.type === 'run-completed') return event.totalMs;
  return 0;
}

function metricsForEvent(event: TurnEvent, model?: TelemetryModel): Record<string, number> {
  const metrics: Record<string, number> = {
    seq: event.seq,
    turn: event.turn,
    durationMs: durationForEvent(event),
  };

  addMetric(metrics, 'snapshotBytes', event.type === 'observe-completed' ? event.snapshotBytes : undefined);
  addMetric(metrics, 'screenshotBytes', event.type === 'observe-completed' ? byteLength(event.screenshot) : undefined);
  addMetric(metrics, 'tokenCount', event.type === 'decide-token' ? event.tokenCount : undefined);
  addMetric(metrics, 'totalTurns', event.type === 'run-completed' ? event.totalTurns : undefined);
  addMetric(metrics, 'totalMs', event.type === 'run-completed' ? event.totalMs : undefined);
  addMetric(metrics, 'maxTurns', event.type === 'run-started' ? event.maxTurns : undefined);
  addMetric(metrics, 'stepCount', event.type === 'plan-completed' ? event.stepCount : undefined);
  addMetric(metrics, 'stepIndex', 'stepIndex' in event ? event.stepIndex : undefined);
  addMetric(metrics, 'totalSteps', 'totalSteps' in event ? event.totalSteps : undefined);
  addMetric(metrics, 'stepsCompleted', event.type === 'plan-fallback-entered' ? event.stepsCompleted : undefined);
  addMetric(metrics, 'replanIndex', event.type === 'plan-replan-started' ? event.replanIndex : undefined);
  addMetric(metrics, 'maxReplans', event.type === 'plan-replan-started' ? event.maxReplans : undefined);
  const usage = usageForEvent(event);
  const usageReported = hasUsage(usage);
  addMetric(metrics, 'modelCall', isModelCallEvent(event) ? 1 : undefined);
  addMetric(metrics, 'usageReported', isModelCallEvent(event) ? (usageReported ? 1 : 0) : undefined);
  addMetric(metrics, 'missingUsage', isModelCallEvent(event) ? (usageReported ? 0 : 1) : undefined);
  addMetric(metrics, 'planStepFailure', event.type === 'plan-step-executed' && (!event.executeSuccess || !event.verified) ? 1 : undefined);
  addMetric(metrics, 'inputTokens', usage.inputTokens);
  addMetric(metrics, 'outputTokens', usage.outputTokens);
  addMetric(metrics, 'cacheReadInputTokens', usage.cacheReadInputTokens);
  addMetric(metrics, 'cacheCreationInputTokens', usage.cacheCreationInputTokens);
  if (event.type === 'turn-completed') {
    addMetric(metrics, 'turnInputTokens', event.turnArtifact.inputTokens);
    addMetric(metrics, 'turnOutputTokens', event.turnArtifact.outputTokens);
    addMetric(metrics, 'turnCacheReadInputTokens', event.turnArtifact.cacheReadInputTokens);
    addMetric(metrics, 'turnCacheCreationInputTokens', event.turnArtifact.cacheCreationInputTokens);
  }

  if (model && usageReported) {
    metrics.estimatedCostUsd = calculateCost(
      model.name,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      usage.cacheReadInputTokens ?? 0,
      usage.inputTokens ?? 0,
    );
  }

  return metrics;
}

function dataForEvent(event: TurnEvent, phase: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    eventType: event.type,
    phase,
    status: statusForEvent(event),
    spanId: spanIdForEvent(event),
    seq: event.seq,
    turn: event.turn,
    ts: event.ts,
  };
  const parentSpanId = parentSpanIdForEvent(event);
  if (parentSpanId) data.parentSpanId = parentSpanId;

  if (event.type === 'run-started') {
    data.goalHash = shortHash(event.goal);
    data.goalLength = event.goal.length;
    if (event.startUrl) data.startUrl = sanitiseUrl(event.startUrl);
  }

  if (event.type === 'observe-completed') {
    data.url = sanitiseUrl(event.url);
    data.urlHash = shortHash(event.url);
    data.title = truncate(event.title);
  }

  const action = actionForEvent(event);
  if (action) {
    data.toolName = action.action;
    data.toolArgsHash = shortHash(stableStringify(action));
    data.toolArgsPreview = actionPreview(action);
  }

  if ('expectedEffect' in event && typeof event.expectedEffect === 'string') {
    data.expectedEffect = truncate(event.expectedEffect);
  }

  if (event.type === 'verify-completed') {
    data.verificationVerdict = event.verified ? 'verified' : 'rejected';
    if (event.reason) data.reason = truncate(event.reason);
  }

  if (event.type === 'execute-completed') {
    data.executionStatus = event.success ? 'success' : 'failure';
    if (event.error) {
      data.errorClass = classifyError(event.error);
      data.errorMessage = truncate(event.error);
      data.toolResultHash = shortHash(event.error);
      data.toolResultPreview = truncate(event.error);
    }
    if (event.bounds) data.bounds = event.bounds;
  }

  if (event.type === 'decide-completed' && event.reasoning) {
    data.reasoningHash = shortHash(event.reasoning);
    data.reasoningPreview = truncate(event.reasoning);
  }

  if (event.type === 'decide-skipped-cached') {
    data.cacheKey = event.cacheKey;
  }

  if (event.type === 'decide-skipped-pattern') {
    data.patternId = event.patternId;
  }

  if (event.type === 'plan-completed') {
    data.planHash = shortHash(stableStringify(event.plan ?? { steps: [] }));
    data.planPreview = planPreview(event.plan);
    if (event.parseError) {
      data.planFailure = 'parse_or_validation_error';
      data.reason = truncate(event.parseError);
    }
  }

  if (event.type === 'plan-step-executed') {
    data.planStepStatus = statusForEvent(event);
    data.executionStatus = event.executeSuccess ? 'success' : 'failure';
    data.verificationVerdict = event.verified ? 'verified' : 'rejected';
    if (event.verifyReason) data.reason = truncate(event.verifyReason);
  }

  if (event.type === 'plan-deviated') {
    data.reason = truncate(event.reason);
  }

  if (event.type === 'plan-fallback-entered') {
    data.fallbackContextHash = shortHash(event.fallbackContext);
    data.fallbackContextPreview = truncate(event.fallbackContext);
  }

  if (event.type === 'plan-replan-started') {
    data.reason = truncate(event.reason);
  }

  if (event.type === 'recovery-fired') {
    data.strategy = event.strategy;
    data.feedbackHash = shortHash(event.feedback);
    data.feedbackPreview = truncate(event.feedback);
    if (event.forcedAction) data.forcedAction = truncate(event.forcedAction);
  }

  if (event.type === 'override-applied') {
    data.source = event.source;
    data.reasoningTag = event.reasoningTag;
    data.feedbackHash = shortHash(event.feedback);
    data.feedbackPreview = truncate(event.feedback);
  }

  if (event.type === 'turn-completed') {
    addTurnData(data, event.turnArtifact);
  }

  if (event.type === 'run-completed') {
    data.runStatus = event.success ? 'success' : 'failure';
    if (event.reason) data.reason = truncate(event.reason);
  }

  return data;
}

function addTurnData(data: Record<string, unknown>, turn: Turn): void {
  data.turnDurationMs = turn.durationMs;
  if (turn.modelUsed) data.modelUsed = turn.modelUsed;
  if (turn.expectedEffect) data.expectedEffect = truncate(turn.expectedEffect);
  if (typeof turn.verified === 'boolean') data.verificationVerdict = turn.verified ? 'verified' : 'rejected';
  if (turn.verificationFailure) data.reason = truncate(turn.verificationFailure);
  if (turn.error) {
    data.errorClass = classifyError(turn.error);
    data.errorMessage = truncate(turn.error);
  }
  if (turn.rawLLMResponse) data.rawLlmResponseHash = shortHash(turn.rawLLMResponse);
  if (turn.reasoning) data.reasoningHash = shortHash(turn.reasoning);
}

function createRunTelemetrySummary(): RunTelemetrySummary {
  return {
    eventCount: 0,
    modelCallCount: 0,
    toolCallCount: 0,
    screenshotCount: 0,
    executeFailureCount: 0,
    verificationRejectionCount: 0,
    recoveryCount: 0,
    overrideCount: 0,
    planDeviationCount: 0,
    planFallbackCount: 0,
    planStepCount: 0,
    planStepFailureCount: 0,
    decideCacheHits: 0,
    decidePatternSkips: 0,
    usageReportedCount: 0,
    missingUsageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedCostUsd: 0,
    snapshotBytes: 0,
    screenshotBytes: 0,
    completedTurns: 0,
    eventCounts: {},
    actionCounts: {},
    modelCounts: {},
    errorCounts: {},
    phaseDurationsMs: {},
    emittedRunSummary: false,
  };
}

function recordRunTelemetrySummary(
  summary: RunTelemetrySummary,
  event: TurnEvent,
  fallbackModel?: TelemetryModel,
): void {
  summary.eventCount += 1;
  increment(summary.eventCounts, event.type);

  const phase = phaseForEvent(event);
  const durationMs = durationForEvent(event);
  if (durationMs > 0 && phase !== 'run' && phase !== 'turn') {
    increment(summary.phaseDurationsMs, phase, durationMs);
  }

  if (event.type === 'run-started') {
    summary.maxTurns = event.maxTurns;
    summary.goalHash = shortHash(event.goal);
    summary.goalLength = event.goal.length;
    if (event.startUrl) summary.startUrl = sanitiseUrl(event.startUrl);
  }

  if (event.type === 'observe-completed') {
    summary.snapshotBytes += event.snapshotBytes;
    const screenshotBytes = byteLength(event.screenshot);
    if (screenshotBytes) {
      summary.screenshotCount += 1;
      summary.screenshotBytes += screenshotBytes;
    }
  }

  if (event.type === 'decide-skipped-cached') summary.decideCacheHits += 1;
  if (event.type === 'decide-skipped-pattern') summary.decidePatternSkips += 1;
  if (event.type === 'execute-completed') {
    summary.toolCallCount += 1;
    increment(summary.actionCounts, event.action.action);
    if (!event.success) summary.executeFailureCount += 1;
  }
  if (event.type === 'verify-completed' && !event.verified) summary.verificationRejectionCount += 1;
  if (event.type === 'recovery-fired') summary.recoveryCount += 1;
  if (event.type === 'override-applied') summary.overrideCount += 1;
  if (event.type === 'plan-deviated') summary.planDeviationCount += 1;
  if (event.type === 'plan-fallback-entered') summary.planFallbackCount += 1;
  if (event.type === 'plan-step-executed') {
    summary.planStepCount += 1;
    if (!event.executeSuccess || !event.verified) summary.planStepFailureCount += 1;
  }
  if (event.type === 'turn-completed') summary.completedTurns += 1;

  const action = actionForEvent(event);
  if (action && event.type !== 'execute-completed') {
    increment(summary.actionCounts, `${event.type}:${action.action}`);
  }

  const usage = usageForEvent(event);
  if (isModelCallEvent(event)) {
    summary.modelCallCount += 1;
    if (hasUsage(usage)) summary.usageReportedCount += 1;
    else summary.missingUsageCount += 1;
    summary.inputTokens += usage.inputTokens ?? 0;
    summary.outputTokens += usage.outputTokens ?? 0;
    summary.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    summary.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    const model = modelForEvent(event, fallbackModel);
    if (model) {
      increment(summary.modelCounts, `${model.provider}:${model.name}`);
      summary.estimatedCostUsd += calculateCost(
        model.name,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0,
        usage.inputTokens ?? 0,
      );
    }
  }

  const error = errorForEvent(event);
  if (error) increment(summary.errorCounts, classifyError(error));
}

function emitRunTelemetrySummary(
  summary: RunTelemetrySummary,
  event: Extract<TurnEvent, { type: 'run-completed' }>,
  telemetry: TelemetryClient,
  fallbackModel?: TelemetryModel,
): void {
  telemetry.emit({
    kind: 'agent-run',
    runId: event.runId,
    ok: event.success,
    durationMs: event.totalMs,
    data: {
      eventType: 'run-summary',
      phase: 'run',
      status: event.success ? 'completed' : 'failed',
      spanId: runSpanId(event.runId),
      totalTurns: event.totalTurns,
      eventCounts: summary.eventCounts,
      actionCounts: summary.actionCounts,
      modelCounts: summary.modelCounts,
      errorCounts: summary.errorCounts,
      phaseDurationsMs: summary.phaseDurationsMs,
      ...(summary.goalHash ? { goalHash: summary.goalHash } : {}),
      ...(summary.goalLength !== undefined ? { goalLength: summary.goalLength } : {}),
      ...(summary.startUrl ? { startUrl: summary.startUrl } : {}),
      ...(event.reason ? { reason: truncate(event.reason) } : {}),
    },
    metrics: {
      eventCount: summary.eventCount,
      totalTurns: event.totalTurns,
      completedTurns: summary.completedTurns,
      totalMs: event.totalMs,
      modelCallCount: summary.modelCallCount,
      toolCallCount: summary.toolCallCount,
      screenshotCount: summary.screenshotCount,
      executeFailureCount: summary.executeFailureCount,
      verificationRejectionCount: summary.verificationRejectionCount,
      recoveryCount: summary.recoveryCount,
      overrideCount: summary.overrideCount,
      planDeviationCount: summary.planDeviationCount,
      planFallbackCount: summary.planFallbackCount,
      planStepCount: summary.planStepCount,
      planStepFailureCount: summary.planStepFailureCount,
      decideCacheHits: summary.decideCacheHits,
      decidePatternSkips: summary.decidePatternSkips,
      usageReportedCount: summary.usageReportedCount,
      missingUsageCount: summary.missingUsageCount,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadInputTokens: summary.cacheReadInputTokens,
      cacheCreationInputTokens: summary.cacheCreationInputTokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      snapshotBytes: summary.snapshotBytes,
      screenshotBytes: summary.screenshotBytes,
      ...(summary.maxTurns !== undefined ? { maxTurns: summary.maxTurns } : {}),
    },
    tags: {
      eventType: 'run-summary',
      phase: 'run',
      status: event.success ? 'completed' : 'failed',
    },
    ...(fallbackModel ? { model: fallbackModel } : {}),
    ...(event.reason && !event.success ? { error: event.reason } : {}),
  });
}

function usageForEvent(event: TurnEvent): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
} {
  if (event.type === 'decide-completed' || event.type === 'plan-completed') {
    return {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
    };
  }

  return {};
}

function isModelCallEvent(event: TurnEvent): boolean {
  return event.type === 'decide-completed' || event.type === 'plan-completed';
}

function hasUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): boolean {
  return Boolean(
    usage.inputTokens
      || usage.outputTokens
      || usage.cacheReadInputTokens
      || usage.cacheCreationInputTokens,
  );
}

function spanIdForEvent(event: TurnEvent): string {
  if (event.type === 'run-started') return runSpanId(event.runId);
  if (event.type === 'turn-started') return turnSpanId(event.runId, event.turn);
  return shortHash(`${event.runId}:${event.turn}:${event.seq}:${event.type}`);
}

function parentSpanIdForEvent(event: TurnEvent): string | undefined {
  if (event.type === 'run-started') return undefined;
  if (event.type === 'turn-started') return runSpanId(event.runId);
  if (event.turn > 0) return turnSpanId(event.runId, event.turn);
  return runSpanId(event.runId);
}

function runSpanId(runId: string): string {
  return shortHash(`${runId}:run`);
}

function turnSpanId(runId: string, turn: number): string {
  return shortHash(`${runId}:turn:${turn}`);
}

function actionForEvent(event: TurnEvent): Action | undefined {
  if ('action' in event) return event.action as Action;
  if (event.type === 'turn-completed') return event.turnArtifact.action;
  return undefined;
}

function modelForEvent(event: TurnEvent, fallback?: TelemetryModel): TelemetryModel | undefined {
  if (event.type === 'decide-completed' && event.modelUsed) {
    return {
      provider: fallback?.provider ?? 'unknown',
      name: event.modelUsed,
      ...(fallback?.promptHash ? { promptHash: fallback.promptHash } : {}),
      ...(fallback?.rubricHash ? { rubricHash: fallback.rubricHash } : {}),
    };
  }
  if (event.type === 'plan-completed' && event.modelUsed) {
    return {
      provider: event.providerUsed ?? fallback?.provider ?? 'unknown',
      name: event.modelUsed,
      ...(fallback?.promptHash ? { promptHash: fallback.promptHash } : {}),
      ...(fallback?.rubricHash ? { rubricHash: fallback.rubricHash } : {}),
    };
  }
  if (event.type === 'turn-completed' && event.turnArtifact.modelUsed) {
    return {
      provider: fallback?.provider ?? 'unknown',
      name: event.turnArtifact.modelUsed,
      ...(fallback?.promptHash ? { promptHash: fallback.promptHash } : {}),
      ...(fallback?.rubricHash ? { rubricHash: fallback.rubricHash } : {}),
    };
  }
  return fallback;
}

function modelFromConfig(config?: AgentConfig): TelemetryModel {
  return {
    provider: config?.provider ?? 'openai',
    name: config?.model ?? 'gpt-5.4',
  };
}

function errorForEvent(event: TurnEvent): string | undefined {
  if (event.type === 'execute-completed' && event.error) return event.error;
  if (event.type === 'verify-completed' && !event.verified && event.reason) return event.reason;
  if (event.type === 'run-completed' && !event.success && event.reason) return event.reason;
  if (event.type === 'plan-deviated') return event.reason;
  if (event.type === 'plan-completed' && event.parseError) return event.parseError;
  if (event.type === 'plan-step-executed' && event.verifyReason) return event.verifyReason;
  return undefined;
}

function planPreview(eventPlan: Extract<TurnEvent, { type: 'plan-completed' }>['plan']): Record<string, unknown> {
  if (!eventPlan) {
    return { stepCount: 0 };
  }

  const preview: Record<string, unknown> = {
    stepCount: eventPlan.steps.length,
  };
  if (eventPlan.finalResult) {
    preview.finalResultLength = eventPlan.finalResult.length;
    preview.finalResultHash = shortHash(eventPlan.finalResult);
  }
  if (eventPlan.reasoning) {
    preview.reasoningLength = eventPlan.reasoning.length;
    preview.reasoningHash = shortHash(eventPlan.reasoning);
  }
  preview.steps = eventPlan.steps.slice(0, 12).map((step, index) => {
    const stepPreview: Record<string, unknown> = {
      index: index + 1,
      action: actionPreview(step.action),
    };
    if (step.expectedEffect) {
      stepPreview.expectedEffectLength = step.expectedEffect.length;
      stepPreview.expectedEffectHash = shortHash(step.expectedEffect);
    }
    if (step.rationale) {
      stepPreview.rationaleLength = step.rationale.length;
      stepPreview.rationaleHash = shortHash(step.rationale);
    }
    return stepPreview;
  });
  return preview;
}

function actionPreview(action: Action): Record<string, unknown> {
  const raw = action as unknown as Record<string, unknown>;
  const preview: Record<string, unknown> = { action: action.action };
  copyString(raw, preview, 'selector');
  copyString(raw, preview, 'key');
  copyString(raw, preview, 'direction');
  copyNumber(raw, preview, 'amount');
  copyNumber(raw, preview, 'ms');
  copyNumber(raw, preview, 'x');
  copyNumber(raw, preview, 'y');
  copyNumber(raw, preview, 'label');
  copyString(raw, preview, 'name');

  if (typeof raw.url === 'string') {
    preview.url = sanitiseUrl(raw.url);
    preview.urlHash = shortHash(raw.url);
  }

  for (const field of ['text', 'value', 'result', 'criteria', 'reason', 'script']) {
    if (typeof raw[field] === 'string') {
      preview[`${field}Length`] = raw[field].length;
      preview[`${field}Hash`] = shortHash(raw[field]);
    }
  }

  if (Array.isArray(raw.refs)) {
    preview.refCount = raw.refs.length;
    preview.refs = raw.refs.slice(0, 12);
  }

  if (isRecord(raw.fields)) {
    const keys = Object.keys(raw.fields);
    preview.fieldCount = keys.length;
    preview.fieldRefs = keys.slice(0, 20);
  }

  if (isRecord(raw.selects)) {
    const keys = Object.keys(raw.selects);
    preview.selectCount = keys.length;
    preview.selectRefs = keys.slice(0, 20);
  }

  if (Array.isArray(raw.checks)) {
    preview.checkCount = raw.checks.length;
    preview.checkRefs = raw.checks.slice(0, 20);
  }

  if (isRecord(raw.args)) {
    preview.argKeys = Object.keys(raw.args).sort();
    preview.argsHash = shortHash(stableStringify(raw.args));
  }

  if (Array.isArray(raw.subGoals)) {
    preview.subGoalCount = raw.subGoals.length;
    preview.subGoalsHash = shortHash(stableStringify(raw.subGoals));
  }

  if (Array.isArray(raw.items)) {
    preview.itemCount = raw.items.length;
    preview.itemsHash = shortHash(stableStringify(raw.items));
  }

  return preview;
}

function addMetric(metrics: Record<string, number>, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
}

function increment(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function copyString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === 'string') target[key] = truncate(source[key]);
}

function copyNumber(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (typeof source[key] === 'number') target[key] = source[key];
}

function classifyError(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('not found') || lower.includes('missing selector')) return 'not_found';
  if (lower.includes('navigation')) return 'navigation';
  if (lower.includes('permission') || lower.includes('denied')) return 'permission';
  return 'error';
}

function sanitiseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return truncate(url.toString());
  } catch {
    return truncate(raw.split(/[?#]/, 1)[0] ?? raw);
  }
}

function truncate(value: string, max = MAX_PREVIEW_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function byteLength(value?: string): number | undefined {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
