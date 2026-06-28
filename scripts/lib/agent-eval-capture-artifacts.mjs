import fs from 'node:fs';
import path from 'node:path';

const RAW_PROVIDER_FILE_PREFIX = 'raw-provider-events.ndjson';

export function configureAgentEvalCaptureEnv({
  childEnv,
  mode,
  rootDir,
  scenarioId,
  candidateId,
}) {
  const requestedRoot = childEnv.BAD_AGENT_EVAL_CAPTURE_DIR || childEnv.BAD_AGENT_EVAL_TRACE_DIR;
  if (!requestedRoot) return { enabled: false };

  const root = path.resolve(rootDir, requestedRoot);
  const dir = path.join(root, safePathPart(mode));
  childEnv.BAD_AGENT_EVAL_CAPTURE_DIR = dir;
  childEnv.BAD_AGENT_EVAL_SCENARIO_ID ||= scenarioId ?? mode;
  childEnv.BAD_AGENT_EVAL_CANDIDATE_ID ||= candidateId ?? 'baseline';
  childEnv.BAD_AGENT_EVAL_RUN_ID = `${safePathPart(childEnv.BAD_AGENT_EVAL_SCENARIO_ID)}-${safePathPart(mode)}`;

  return {
    enabled: true,
    dir,
    require: childEnv.BAD_AGENT_EVAL_CAPTURE_REQUIRE === '1',
  };
}

export function inspectAgentEvalCaptureArtifacts(dir, { require = false } = {}) {
  const rawProviderDir = path.join(dir, 'raw-provider');
  const tracesDir = path.join(dir, 'traces');
  const rawProviderFiles = listFiles(rawProviderDir)
    .filter((file) => path.basename(file).startsWith(RAW_PROVIDER_FILE_PREFIX));
  const traceFiles = listFiles(tracesDir);
  const rawProviderEvents = rawProviderFiles.reduce((sum, file) => sum + countJsonlRows(file), 0);
  const traceRows = traceFiles.reduce((sum, file) => sum + countJsonlRows(file), 0);
  const failures = [];

  if (require && rawProviderEvents === 0) {
    failures.push(`agent-eval capture emitted no raw-provider events in ${rawProviderDir}`);
  }
  if (require && traceRows === 0) {
    failures.push(`agent-eval capture emitted no trace rows in ${tracesDir}`);
  }

  return {
    dir,
    rawProviderDir,
    tracesDir,
    rawProviderFiles,
    traceFiles,
    rawProviderEvents,
    traceRows,
    passed: failures.length === 0,
    failures,
  };
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((entry) => path.join(dir, entry))
    .filter((file) => fs.statSync(file).isFile())
    .sort();
}

function countJsonlRows(file) {
  const body = fs.readFileSync(file, 'utf-8');
  return body.split('\n').filter((line) => line.trim().length > 0).length;
}

function safePathPart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
