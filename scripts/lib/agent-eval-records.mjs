import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertRealBackend,
  buildAgentInterfaceProfileCell,
  recordRunsToScorecard,
  validateRunRecord,
} from '@tangle-network/agent-eval';

const SNAPSHOT_PATTERN = /(?:@.+|-\d{8}|-\d{4}-\d{2}-\d{2}|:date-.+)$/;
const SPLIT_TAGS = new Set(['search', 'dev', 'holdout']);

export async function recordTrackSummaryAgentEval(summary, options) {
  const recordsPath = options.recordsPath ? path.resolve(options.recordsPath) : undefined;
  const scorecardPath = options.scorecardPath ? path.resolve(options.scorecardPath) : undefined;
  if (!recordsPath && !scorecardPath) {
    throw new Error('agent-eval recording requires recordsPath or scorecardPath');
  }

  const { records, rejected, profile } = await trackSummaryToRunRecords(summary, options);
  if (rejected.length > 0) {
    throw new Error(formatRejections(rejected));
  }
  if (records.length === 0) {
    throw new Error('agent-eval recording produced zero RunRecords');
  }

  const backendIntegrity = assertRealBackend(records, {
    allowMixed: options.allowMixedBackend === true,
  });

  if (recordsPath) {
    writeJsonl(recordsPath, records);
  }

  let scorecardLines = [];
  if (scorecardPath) {
    scorecardLines = recordRunsToScorecard(scorecardPath, records, {
      profile,
      commitSha: requireCommitSha(options.commitSha ?? summary.gitSha),
    });
  }

  return {
    records,
    rejected,
    profile,
    backendIntegrity,
    recordsPath,
    scorecardPath,
    scorecardLines,
  };
}

export async function recordTelemetryAgentEval(options) {
  const recordsPath = options.recordsPath ? path.resolve(options.recordsPath) : undefined;
  const scorecardPath = options.scorecardPath ? path.resolve(options.scorecardPath) : undefined;
  if (!recordsPath && !scorecardPath) {
    throw new Error('agent-eval recording requires recordsPath or scorecardPath');
  }

  const envelopes = readTelemetryEnvelopes(options.telemetryDirs ?? []);
  const { records, rejected, profile } = await telemetryEnvelopesToRunRecords(envelopes, options);
  if (rejected.length > 0) {
    throw new Error(formatRejections(rejected));
  }
  if (records.length === 0) {
    throw new Error('agent-eval recording found no agent-run telemetry records');
  }

  const backendIntegrity = assertRealBackend(records, {
    allowMixed: options.allowMixedBackend === true,
  });

  if (recordsPath) {
    writeJsonl(recordsPath, records);
  }

  let scorecardLines = [];
  if (scorecardPath) {
    scorecardLines = recordRunsToScorecard(scorecardPath, records, {
      profile,
      commitSha: requireCommitSha(options.commitSha),
    });
  }

  return {
    records,
    rejected,
    profile,
    backendIntegrity,
    recordsPath,
    scorecardPath,
    scorecardLines,
  };
}

export async function telemetryEnvelopesToRunRecords(envelopes, options) {
  const modelSnapshot = requireSnapshot(options.modelSnapshot);
  const promptHash = requireHash('promptHash', options.promptHash);
  const configHash = requireHash('configHash', options.configHash);
  const commitSha = requireCommitSha(options.commitSha);
  const splitTag = requireSplitTag(options.splitTag ?? 'search');
  const profile = await buildBadBenchmarkProfile(
    {
      benchmarkProfile: options.benchmarkProfile,
      driverProfile: options.driverProfile,
    },
    {
      profile: options.profile,
      profileName: options.profileName,
      profileVersion: options.profileVersion,
      modelSnapshot,
      promptHash,
      modes: options.modes ?? [],
    },
  );
  const agentProfile = await buildAgentInterfaceProfileCell(profile, {
    harness: {
      id: 'browser-agent-driver',
      version: String(options.profileVersion ?? profile.version),
    },
    model: modelSnapshot,
    promptHash,
    dimensions: {
      benchmarkProfile: stringOrUndefined(options.benchmarkProfile),
      driverProfile: stringOrUndefined(options.driverProfile),
      splitTag,
    },
  });

  const records = [];
  const rejected = [];
  for (const envelope of envelopes) {
    if (envelope?.kind !== 'agent-run') continue;
    try {
      records.push(
        agentRunEnvelopeToRunRecord(envelope, {
          experimentId: options.experimentId,
          candidateId: options.candidateId,
          seed: options.seed,
          scenarioId: options.scenarioId,
          splitTag,
          modelSnapshot,
          promptHash,
          configHash,
          commitSha,
          agentProfile,
          requireModelUsage: options.requireModelUsage !== false,
        }),
      );
    } catch (error) {
      rejected.push({
        runId: stringOrUndefined(envelope?.runId),
        scenarioId: stringOrUndefined(options.scenarioId),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { records, rejected, profile };
}

export function agentRunEnvelopeToRunRecord(envelope, options) {
  if (!envelope || envelope.kind !== 'agent-run') {
    throw new Error(`expected agent-run telemetry, got ${String(envelope?.kind)}`);
  }
  if (!stringOrUndefined(envelope.runId)) {
    throw new Error('agent-run telemetry is missing runId');
  }
  const metrics = envelope.metrics ?? {};
  if (options.requireModelUsage !== false && metric(metrics, 'modelCallCount') <= 0) {
    throw new Error('agent-run telemetry has no model usage');
  }

  const splitTag = requireSplitTag(options.splitTag ?? 'search');
  const score = envelope.ok === false ? 0 : 1;
  const record = {
    runId: envelope.runId,
    experimentId: requireString('experimentId', options.experimentId),
    candidateId: requireString('candidateId', options.candidateId),
    seed: requireFiniteNumber('seed', numberOrUndefined(options.seed)),
    scenarioId: requireString('scenarioId', options.scenarioId),
    splitTag,
    model: requireSnapshot(options.modelSnapshot),
    promptHash: requireHash('promptHash', options.promptHash),
    configHash: requireHash('configHash', options.configHash),
    commitSha: requireCommitSha(options.commitSha ?? envelope.source?.gitSha),
    wallMs: nonNegativeNumber('wallMs', metric(envelope, 'durationMs')),
    costUsd: nonNegativeNumber('costUsd', metric(metrics, 'estimatedCostUsd')),
    tokenUsage: {
      input: nonNegativeNumber('tokenUsage.input', metric(metrics, 'inputTokens')),
      output: nonNegativeNumber('tokenUsage.output', metric(metrics, 'outputTokens')),
      cached: nonNegativeNumber('tokenUsage.cached', metric(metrics, 'cacheReadInputTokens')),
    },
    outcome: {
      raw: telemetryOutcomeRaw(envelope),
      ...(splitTag === 'holdout' ? { holdoutScore: score } : { searchScore: score }),
    },
    ...(envelope.ok === false ? { failureMode: telemetryFailureMode(envelope) } : {}),
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
  };

  return validateRunRecord(record);
}

export function readTelemetryEnvelopes(dirs) {
  const envelopes = [];
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const filePath of listJsonlFiles(path.resolve(dir))) {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          envelopes.push(JSON.parse(trimmed));
        } catch (error) {
          throw new Error(`Invalid telemetry JSONL in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return envelopes;
}

export function concatenateAgentEvalJsonl(options) {
  const inputPaths = options.inputPaths ?? [];
  const outputPath = path.resolve(requireString('outputPath', options.outputPath));
  const label = requireString('label', options.label);
  const requireUniqueRunIds = options.requireUniqueRunIds === true;
  if (inputPaths.length === 0) {
    throw new Error(`No child ${label} files were produced`);
  }

  const seenRunIds = new Set();
  const lines = [];
  for (const inputPath of inputPaths) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Missing child ${label} file: ${inputPath}`);
    }
    for (const line of fs.readFileSync(inputPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      if (requireUniqueRunIds) {
        const runId = requireString('runId', parsed?.runId);
        if (seenRunIds.has(runId)) {
          throw new Error(`Duplicate RunRecord runId while aggregating ${label}: ${runId}`);
        }
        seenRunIds.add(runId);
      }
      lines.push(trimmed);
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
  return lines.length;
}

export async function trackSummaryToRunRecords(summary, options) {
  if (!summary || typeof summary !== 'object') {
    throw new Error('track summary must be an object');
  }
  const experimentId = requireString('experimentId', options.experimentId);
  const candidateId = requireString('candidateId', options.candidateId);
  const seed = requireFiniteNumber('seed', numberOrUndefined(options.seed));
  const splitTag = requireSplitTag(options.splitTag ?? 'search');
  const modelSnapshot = requireSnapshot(options.modelSnapshot);
  const promptHash = requireHash('promptHash', options.promptHash ?? inferPromptHash(summary));
  const configHash = requireHash('configHash', options.configHash);
  const commitSha = requireCommitSha(options.commitSha ?? summary.gitSha);
  const profile = await buildBadBenchmarkProfile(summary, {
    profile: options.profile,
    profileName: options.profileName,
    profileVersion: options.profileVersion,
    modelSnapshot,
    promptHash,
    modes: modesFromSummary(summary),
  });
  const agentProfile = await buildAgentInterfaceProfileCell(profile, {
    harness: {
      id: 'browser-agent-driver',
      version: String(options.profileVersion ?? profile.version),
    },
    model: modelSnapshot,
    promptHash,
    dimensions: {
      benchmarkProfile: stringOrUndefined(summary.benchmarkProfile),
      driverProfile: stringOrUndefined(summary.driverProfile),
      splitTag,
    },
  });

  const records = [];
  const rejected = [];
  for (const item of summary.results ?? []) {
    const scenarioId = requireString(
      'scenarioId',
      stringOrUndefined(item?.scenarioId) ?? stringOrUndefined(item?.scenarioName),
    );
    for (const run of item?.summary?.runs ?? []) {
      try {
        records.push(
          baselineRunToRunRecord(run, {
            scenarioId,
            experimentId,
            candidateId,
            seed,
            splitTag,
            modelSnapshot,
            promptHash,
            configHash,
            commitSha,
            agentProfile,
            requireModelUsage: options.requireModelUsage !== false,
          }),
        );
      } catch (error) {
        rejected.push({
          scenarioId,
          mode: stringOrUndefined(run?.mode),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { records, rejected, profile };
}

export async function buildBadBenchmarkProfile(summary, options) {
  if (options.profile) return options.profile;
  const profileName = requireString('profileName', options.profileName ?? 'bad-browser-agent');
  const profileVersion = requireString(
    'profileVersion',
    options.profileVersion ?? stringOrUndefined(summary.driverProfile) ?? 'unknown',
  );
  return {
    name: profileName,
    version: profileVersion,
    model: {
      default: requireSnapshot(options.modelSnapshot),
    },
    prompt: {
      hash: requireHash('promptHash', options.promptHash),
    },
    tools: {
      browser: true,
      bash: true,
      playwright: true,
    },
    harness: {
      id: 'browser-agent-driver',
      benchmarkProfile: stringOrUndefined(summary.benchmarkProfile),
      driverProfile: stringOrUndefined(summary.driverProfile),
      modes: options.modes ?? [],
    },
  };
}

export function baselineRunToRunRecord(run, options) {
  const mode = requireString('mode', stringOrUndefined(run?.mode));
  const metrics = run?.metrics ?? {};
  const inputTokens = nonNegativeNumber('tokenUsage.input', metric(metrics, 'inputTokens'));
  const outputTokens = nonNegativeNumber('tokenUsage.output', metric(metrics, 'outputTokens'));
  if (options.requireModelUsage !== false && inputTokens + outputTokens <= 0) {
    throw new Error('benchmark run has no model token usage');
  }

  const score = metrics.passed === true ? 1 : 0;
  const record = {
    runId: makeRunId({
      experimentId: options.experimentId,
      candidateId: options.candidateId,
      seed: options.seed,
      scenarioId: options.scenarioId,
      mode,
      reportPath: stringOrUndefined(run?.reportPath),
    }),
    experimentId: requireString('experimentId', options.experimentId),
    candidateId: requireString('candidateId', options.candidateId),
    seed: requireFiniteNumber('seed', options.seed),
    scenarioId: requireString('scenarioId', options.scenarioId),
    splitTag: requireSplitTag(options.splitTag ?? 'search'),
    model: requireSnapshot(options.modelSnapshot),
    promptHash: requireHash('promptHash', options.promptHash),
    configHash: requireHash('configHash', options.configHash),
    commitSha: requireCommitSha(options.commitSha),
    wallMs: nonNegativeNumber('wallMs', metric(metrics, 'durationMs', durationFromDates(run))),
    costUsd: nonNegativeNumber('costUsd', metric(metrics, 'estimatedCostUsd')),
    tokenUsage: {
      input: inputTokens,
      output: outputTokens,
      cached: nonNegativeNumber('tokenUsage.cached', metric(metrics, 'cacheReadInputTokens')),
    },
    outcome: {
      raw: outcomeRaw(run, metrics, mode),
      ...(options.splitTag === 'holdout' ? { holdoutScore: score } : { searchScore: score }),
    },
    ...(score === 0 ? { failureMode: failureMode(run, metrics) } : {}),
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
  };

  return validateRunRecord(record);
}

function outcomeRaw(run, metrics, mode) {
  const raw = {
    ok: run?.exitCode === 0 && metrics.passed === true ? 1 : 0,
    passed: metrics.passed === true ? 1 : 0,
    agent_success: metrics.agentSuccess === true ? 1 : 0,
    exit_code: metric(run, 'exitCode'),
    duration_ms: metric(metrics, 'durationMs', durationFromDates(run)),
    turns_used: metric(metrics, 'turnsUsed'),
    tokens_used: metric(metrics, 'tokensUsed'),
    input_tokens: metric(metrics, 'inputTokens'),
    output_tokens: metric(metrics, 'outputTokens'),
    cached_input_tokens: metric(metrics, 'cacheReadInputTokens'),
    estimated_cost_usd: metric(metrics, 'estimatedCostUsd'),
    cost_unknown: Number.isFinite(Number(metrics.estimatedCostUsd)) ? 0 : 1,
  };

  const modeHash = hashString(mode).slice(0, 12);
  raw.mode_hash = Number.parseInt(modeHash, 16);
  return raw;
}

function telemetryOutcomeRaw(envelope) {
  const metrics = envelope.metrics ?? {};
  return {
    ok: envelope.ok === false ? 0 : 1,
    duration_ms: metric(envelope, 'durationMs'),
    total_turns: metric(metrics, 'totalTurns'),
    completed_turns: metric(metrics, 'completedTurns'),
    model_calls: metric(metrics, 'modelCallCount'),
    tool_calls: metric(metrics, 'toolCallCount'),
    execute_failures: metric(metrics, 'executeFailureCount'),
    verification_rejections: metric(metrics, 'verificationRejectionCount'),
    plan_step_failures: metric(metrics, 'planStepFailureCount'),
    input_tokens: metric(metrics, 'inputTokens'),
    output_tokens: metric(metrics, 'outputTokens'),
    cached_input_tokens: metric(metrics, 'cacheReadInputTokens'),
    estimated_cost_usd: metric(metrics, 'estimatedCostUsd'),
    snapshot_bytes: metric(metrics, 'snapshotBytes'),
    screenshot_bytes: metric(metrics, 'screenshotBytes'),
  };
}

function telemetryFailureMode(envelope) {
  if (typeof envelope.error === 'string' && envelope.error.trim()) {
    return envelope.error.slice(0, 240);
  }
  const reason = envelope.data?.reason;
  if (typeof reason === 'string' && reason.trim()) return reason.slice(0, 240);
  return 'agent_run_failed';
}

function failureMode(run, metrics) {
  if (typeof metrics.verdict === 'string' && metrics.verdict.trim()) {
    return metrics.verdict.slice(0, 240);
  }
  if (run?.exitCode && run.exitCode !== 0) return `exit_${run.exitCode}`;
  if (metrics.agentSuccess === false) return 'agent_success_false';
  if (metrics.passed === false) return 'verification_failed';
  return 'benchmark_run_failed';
}

function inferPromptHash(summary) {
  for (const result of summary.results ?? []) {
    const hash = result?.summary?.promptHash;
    if (typeof hash === 'string' && hash.trim()) return hash;
  }
  return undefined;
}

function modesFromSummary(summary) {
  const modes = new Set();
  for (const result of summary.results ?? []) {
    for (const run of result?.summary?.runs ?? []) {
      if (typeof run?.mode === 'string' && run.mode.trim()) modes.add(run.mode);
    }
  }
  return [...modes].sort();
}

function formatRejections(rejected) {
  const details = rejected
    .slice(0, 8)
    .map((item) => `${item.scenarioId ?? 'unknown'}:${item.mode ?? 'unknown'} ${item.reason}`)
    .join('; ');
  const suffix = rejected.length > 8 ? `; +${rejected.length - 8} more` : '';
  return `agent-eval recording rejected ${rejected.length} run(s): ${details}${suffix}`;
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function listJsonlFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files.sort();
}

function makeRunId(parts) {
  const label = [
    'bad',
    slug(parts.candidateId),
    `s${parts.seed}`,
    slug(parts.scenarioId),
    slug(parts.mode),
  ].join(':');
  const hash = hashString(JSON.stringify(parts)).slice(0, 12);
  return `${label}:${hash}`.slice(0, 180);
}

function durationFromDates(run) {
  const started = Date.parse(run?.startedAt ?? '');
  const ended = Date.parse(run?.endedAt ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  return ended - started;
}

function metric(source, key, fallback = 0) {
  if (!source || source[key] === undefined || source[key] === null) {
    return fallback;
  }
  const value = Number(source?.[key]);
  if (Number.isFinite(value)) return value;
  throw new Error(`${key} must be numeric`);
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberOrUndefined(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSnapshot(value) {
  const model = requireString('modelSnapshot', value);
  if (!SNAPSHOT_PATTERN.test(model)) {
    throw new Error(`modelSnapshot must include a dated or pinned snapshot, got "${model}"`);
  }
  return model;
}

function requireSplitTag(value) {
  const splitTag = requireString('splitTag', value);
  if (!SPLIT_TAGS.has(splitTag)) {
    throw new Error(`splitTag must be one of: ${[...SPLIT_TAGS].join(', ')}`);
  }
  return splitTag;
}

function requireHash(name, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${name} must be a 64-character hex sha256`);
  }
  return value.toLowerCase();
}

function requireCommitSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error('commitSha must be a 40-character git SHA');
  }
  return value.toLowerCase();
}

function requireFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(name, value) {
  const number = requireFiniteNumber(name, value);
  if (number < 0) throw new Error(`${name} must be non-negative`);
  return number;
}

function hashString(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'unknown';
}
