#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  PairwiseSteeringOptimizer,
  validateRunRecord,
} from '@tangle-network/agent-eval';

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const args = argv.slice(1);
const root = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..', '..'));
const defaultStateDir = path.join(root, '.evolve', 'agent-eval', 'webvoyager');

if (command === 'ingest') await ingest();
else if (command === 'optimize') await optimize();
else if (command === 'help') help();
else {
  console.error(`unknown command: ${command}`);
  help();
  process.exit(2);
}

async function ingest() {
  const variantId = requiredArg('variant-id');
  const trackSummary = path.resolve(requiredArg('track-summary'));
  const stateDir = path.resolve(arg('state-dir', defaultStateDir));
  const extractedDir = path.join(stateDir, 'runs', variantId);
  fs.mkdirSync(stateDir, { recursive: true });

  execFileSync('node', [
    path.join(root, 'bench/research/extract-google-flights-corpus.mjs'),
    trackSummary,
    extractedDir,
  ], { cwd: root, stdio: 'inherit' });

  const rows = readJsonl(path.join(extractedDir, 'optimizer-rows.jsonl'))
    .map((row) => withVariant(row, variantId, trackSummary));
  const summary = readJson(path.join(extractedDir, 'summary.json'));
  const runRecords = rows.map((row, index) => toRunRecord(row, summary, index));
  for (const record of runRecords) validateRunRecord(record);

  appendJsonlMany(path.join(stateDir, 'optimizer-rows.jsonl'), rows);
  appendJsonlMany(path.join(stateDir, 'run-records.jsonl'), runRecords);
  appendJsonl(path.join(stateDir, 'events.jsonl'), {
    type: 'ingest',
    at: new Date().toISOString(),
    variantId,
    trackSummary,
    rows: rows.length,
    strictPassRate: summary.strictPassRate,
    rawPassRate: summary.rawPassRate,
    totalCostUsd: summary.totalCostUsd,
    totalTokens: summary.totalTokens,
  });

  writeJson(path.join(stateDir, 'latest-ingest.json'), {
    variantId,
    trackSummary,
    summary,
    rows: rows.length,
    stateDir,
  });

  console.log(JSON.stringify({
    stateDir,
    variantId,
    rows: rows.length,
    strictPassRate: summary.strictPassRate,
    rawPassRate: summary.rawPassRate,
    next: `node bench/research/webvoyager-agent-eval-loop.mjs optimize --state-dir ${shellQuote(stateDir)}`,
  }, null, 2));
}

async function optimize() {
  const stateDir = path.resolve(arg('state-dir', defaultStateDir));
  const rowsPath = path.join(stateDir, 'optimizer-rows.jsonl');
  if (!fs.existsSync(rowsPath)) throw new Error(`missing optimizer rows: ${rowsPath}`);

  const allRows = dedupeRows(readJsonl(rowsPath));
  const variantIds = [...new Set(allRows.map((row) => row.variantId))];
  if (!allRows.length) throw new Error('no optimizer rows');
  const coverage = computeCoverage(allRows, variantIds);
  const scenarioIds = variantIds.length > 1
    ? [...coverage.comparableScenarios]
    : [...coverage.allScenarios];
  if (!scenarioIds.length) {
    throw new Error('no overlapping scenarios across variants; score variants on at least one shared scenario before optimizing');
  }
  const comparableRows = allRows.filter((row) => scenarioIds.includes(row.scenarioId));
  const comparableVariantIds = [...new Set(comparableRows.map((row) => row.variantId))];

  const pairwise = new PairwiseSteeringOptimizer().optimize(comparableRows, {
    weights: {
      success: 5,
      finalGate: 4,
      testReality: 3,
      costUsd: -0.05,
      wallSeconds: -0.02,
    },
  });
  const recommendedVariantId = pairwise.recommendedVariantId;

  const result = {
    generatedAt: new Date().toISOString(),
    stateDir,
    rows: allRows.length,
    comparableRows: comparableRows.length,
    variants: variantIds,
    comparableVariants: comparableVariantIds,
    scenarios: scenarioIds.length,
    coverage: {
      totalScenarios: coverage.allScenarios.size,
      comparableScenarios: scenarioIds.length,
      byVariant: Object.fromEntries([...coverage.byVariant.entries()].map(([variantId, scenarios]) => [variantId, scenarios.size])),
    },
    pairwise,
    selection: {
      method: pairwise.backend,
      recommendedVariantId,
      rankings: pairwise.rankings,
    },
    nextTacticalStep: variantIds.length < 2
      ? 'Implement one real code variant, run train-smoke, ingest it, then rerun optimize.'
      : 'Run dev/holdout scoring for the top candidate before any promotion claim.',
    bullshitAssessment: assessValue({
      variantIds,
      allRows: comparableRows,
      totalRows: allRows.length,
      coverage,
      recommendedVariantId,
    }),
  };

  writeJson(path.join(stateDir, 'optimization-result.json'), result);
  appendJsonl(path.join(stateDir, 'events.jsonl'), {
    type: 'optimize',
    at: result.generatedAt,
    rows: allRows.length,
    variants: variantIds,
    winner: recommendedVariantId,
  });
  console.log(JSON.stringify(result, null, 2));
}

function withVariant(row, variantId, trackSummary) {
  return {
    ...row,
    variantId,
    bundle: {
      ...(row.bundle ?? {}),
      id: variantId,
      label: variantId,
    },
    metadata: {
      ...(row.metadata ?? {}),
      trackSummary,
    },
  };
}

function toRunRecord(row, summary, index) {
  const split = row.metadata?.split === 'dev' ? 'dev' : 'search';
  const score = Number(row.score?.success ?? 0);
  const raw = {};
  for (const [key, value] of Object.entries(row.score ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) raw[key] = value;
  }
  return {
    runId: `${row.variantId}:${row.scenarioId}:${index}`,
    experimentId: String(row.scenarioId),
    candidateId: String(row.variantId),
    seed: index,
    model: 'gpt-5.4@router-2026-04-29',
    promptHash: sha256(String(row.bundle?.prompt ?? row.variantId)),
    configHash: sha256(JSON.stringify({
      benchmark: 'webvoyager',
      mode: 'fast-explore',
      strict: true,
      sourceGeneratedAt: summary.sourceGeneratedAt,
    })),
    commitSha: gitSha(),
    wallMs: Number(row.score?.wallSeconds ?? 0) * 1000,
    costUsd: Number(row.score?.costUsd ?? 0),
    tokenUsage: {
      input: Number(row.metadata?.inputTokens ?? 0),
      output: Number(row.metadata?.outputTokens ?? 0),
    },
    outcome: {
      searchScore: score,
      raw,
    },
    failureMode: Array.isArray(row.score?.notes) ? row.score.notes[0] : undefined,
    splitTag: split,
  };
}

function assessValue({ variantIds, allRows, totalRows, coverage, recommendedVariantId }) {
  const strictPasses = allRows.filter((row) => row.score?.success === 1).length;
  const falsePositiveRisk = allRows.filter((row) => Array.isArray(row.score?.notes) && row.score.notes.includes('verifier-false-positive-risk')).length;
  const calendarFailures = allRows.filter((row) => Array.isArray(row.score?.notes) && row.score.notes.includes('calendar-date-picker')).length;
  const comparableScenarios = coverage?.comparableScenarios?.size;
  return {
    verdict: variantIds.length < 2 ? 'plumbing-only-not-yet-value-proof' : 'variant-comparison-available',
    why: variantIds.length < 2
      ? 'Only the baseline variant has been scored. This proves ingestion, strict scoring, RunRecord validation, and agent-eval ranking, but it does not prove a benchmark improvement.'
      : 'At least two variants are scored on overlapping scenarios. The ranking describes observed scores. Promotion still requires a held-out comparison.',
    evidence: {
      variants: variantIds.length,
      rows: totalRows ?? allRows.length,
      comparableRows: allRows.length,
      totalScenarios: coverage?.allScenarios?.size,
      comparableScenarios,
      strictPasses,
      strictPassRate: allRows.length ? strictPasses / allRows.length : 0,
      falsePositiveRisk,
      calendarFailures,
      recommendedVariantId,
    },
    nextFalsification: 'Score a second real code variant on the same scenarios. If strict pass does not improve or dev regresses, this loop has not earned promotion.',
  };
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows) seen.set(`${row.variantId}\u0000${row.scenarioId}`, row);
  return [...seen.values()];
}

function computeCoverage(rows, variantIds) {
  const allScenarios = new Set(rows.map((row) => row.scenarioId));
  const byVariant = new Map(variantIds.map((variantId) => [variantId, new Set()]));
  const variantsByScenario = new Map();
  for (const row of rows) {
    byVariant.get(row.variantId)?.add(row.scenarioId);
    if (!variantsByScenario.has(row.scenarioId)) variantsByScenario.set(row.scenarioId, new Set());
    variantsByScenario.get(row.scenarioId).add(row.variantId);
  }
  const comparableScenarios = new Set(
    [...variantsByScenario.entries()]
      .filter(([, variants]) => variants.size >= 2)
      .map(([scenarioId]) => scenarioId),
  );
  return { allScenarios, byVariant, variantsByScenario, comparableScenarios };
}

function help() {
  console.log(`webvoyager-agent-eval-loop

Commands:
  ingest --variant-id <id> --track-summary <path> [--state-dir <dir>]
    Convert a BAD track summary into agent-eval optimizer rows and RunRecords.

  optimize [--state-dir <dir>]
    Rank ingested variants with agent-eval PairwiseSteeringOptimizer.

This is intentionally a thin browser adapter. Browser Agent Driver produces and
scores variants; agent-eval ranks them. Promotion still requires separate dev and
holdout results.
`);
}

function arg(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === args.length - 1) return 'true';
  return args[idx + 1];
}

function requiredArg(name) {
  const value = arg(name);
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function appendJsonlMany(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
