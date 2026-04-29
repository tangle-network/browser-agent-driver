#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [, , summaryPathArg, outDirArg] = process.argv;
if (!summaryPathArg) {
  console.error('usage: node bench/research/extract-google-flights-corpus.mjs <track-summary.json> [out-dir]');
  process.exit(2);
}

const summaryPath = path.resolve(summaryPathArg);
const outDir = path.resolve(outDirArg || 'bench/research/google-flights');
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

function classify(goal, verdict, metrics) {
  const text = `${goal}\n${verdict}`.toLowerCase();
  const labels = [];
  if (/\bdate picker|calendar|month|departure|return\b/.test(text)) labels.push('calendar-date-picker');
  if (/\breset|empty destination|empty.*where|generic homepage|did not preserve\b/.test(text)) labels.push('state-reset');
  if (/\bsearch button|did not trigger|results? (?:page|loaded|visible|available)|no actual flight list\b/.test(text)) labels.push('search-submit-results');
  if (/\bexplore|trip in the next 6 months|flexible-date|map\b/.test(text)) labels.push('explore-vs-exact-search');
  if (/\binput tokens exceed|token/.test(text) || (metrics.tokensUsed || 0) > 500000) labels.push('context-token-blowup');
  if (/\btimeout|timed out\b/.test(text)) labels.push('timeout');
  if (/\bnot for the requested|exact requested|not the requested|does not answer|blocked from completing|could not complete|i do not yet have\b/.test(text)) labels.push('verifier-false-positive-risk');
  if (!labels.length && metrics.passed) labels.push('apparently-successful');
  if (!labels.length) labels.push('other');
  return [...new Set(labels)];
}

function strictPass(goal, verdict, metrics) {
  if (!metrics.passed) return false;
  const text = `${goal}\n${verdict}`.toLowerCase();
  return !/\b(blocked from completing|could not complete|unable to (?:fully )?complete|cannot verify|could not verify|i do not yet have|does not (?:answer|show|include|contain|provide)|not for the requested|not the requested|exact requested|specific requested|requested [^.\n]*(?:date|dates?|results?|flight|fare|search)[^.\n]*(?:not|no)[^.\n]*(?:visible|reached|available|confirmed|retrieved)|no actual flight list|cannot truthfully provide|not visible|not available|not currently visible|not reached|not currently reachable)\b/.test(text);
}

function progressFromLabels(metrics, labels) {
  if (strictPass('', metrics.verdict || '', metrics)) return 1;
  if (labels.includes('calendar-date-picker')) return 0.35;
  if (labels.includes('state-reset')) return 0.2;
  if (labels.includes('search-submit-results')) return 0.45;
  if (labels.includes('explore-vs-exact-search')) return 0.4;
  if (labels.includes('context-token-blowup')) return 0.15;
  return metrics.passed ? 0.5 : 0.25;
}

const cases = summary.results.map((result, index) => {
  const run = result.summary?.runs?.[0] || {};
  const metrics = run.metrics || {};
  const goal = result.summary?.goal || '';
  const verdict = metrics.verdict || '';
  const labels = classify(goal, verdict, metrics);
  const strict = strictPass(goal, verdict, metrics);
  return {
    id: result.scenarioId,
    ordinal: index + 1,
    split: index % 5 === 0 ? 'dev' : 'train',
    goal,
    startUrl: result.summary?.url,
    rawPassed: Boolean(metrics.passed),
    strictPassed: strict,
    agentSuccess: Boolean(metrics.agentSuccess),
    exitCode: run.exitCode ?? result.exitCode,
    turnsUsed: metrics.turnsUsed ?? null,
    tokensUsed: metrics.tokensUsed ?? null,
    inputTokens: metrics.inputTokens ?? null,
    outputTokens: metrics.outputTokens ?? null,
    costUsd: metrics.estimatedCostUsd ?? null,
    durationMs: metrics.durationMs ?? null,
    labels,
    verdict,
    reportPath: run.reportPath,
    summaryPath: result.summaryPath,
  };
});

const aggregate = {
  generatedAt: new Date().toISOString(),
  sourceSummaryPath: summaryPath,
  sourceGeneratedAt: summary.generatedAt,
  total: cases.length,
  rawPassed: cases.filter(c => c.rawPassed).length,
  strictPassed: cases.filter(c => c.strictPassed).length,
  rawPassRate: cases.filter(c => c.rawPassed).length / cases.length,
  strictPassRate: cases.filter(c => c.strictPassed).length / cases.length,
  totalCostUsd: summary.totalCostUsd,
  totalTokens: summary.totalTokens,
  meanTurns: cases.reduce((sum, c) => sum + (c.turnsUsed || 0), 0) / cases.length,
  labelCounts: cases.reduce((counts, c) => {
    for (const label of c.labels) counts[label] = (counts[label] || 0) + 1;
    return counts;
  }, {}),
  recommendedMutationPrimitives: [
    {
      id: 'google-flights-direct-url',
      channel: 'code',
      rationale: 'Most failures spend turns in date picker setup. Build Google Flights /travel/flights/search or /travel/explore URLs from parsed route, dates, trip type, cabin, passengers, and stops when task parameters are explicit.',
    },
    {
      id: 'google-flights-calendar-jump-apply',
      channel: 'code',
      rationale: 'When URL direct-start is incomplete, use a deterministic date-field fill/apply macro instead of repeated month-arrow clicks and full calendar snapshots.',
    },
    {
      id: 'google-flights-state-regression-guard',
      channel: 'prompt+code',
      rationale: 'Detect reset to empty origin/destination/date fields after navigation and recover immediately from the encoded URL or last known parsed task parameters.',
    },
    {
      id: 'completion-false-positive-guard',
      channel: 'code',
      rationale: 'Treat completions containing blocked/could-not-complete/not-requested-date language as failed even when script evidence exists.',
    },
    {
      id: 'compact-calendar-observation',
      channel: 'code',
      rationale: 'Summarize calendar state as selected dates, visible months, and relevant target-date availability instead of sending huge DOM snapshots that trigger token blowups.',
    },
  ],
};

const optimizerRows = cases.map((c) => ({
  variantId: 'baseline-gpt-5.4-fast-explore',
  scenarioId: c.id,
  bundle: {
    id: 'baseline-gpt-5.4-fast-explore',
    label: 'baseline gpt-5.4 fast-explore',
    prompt: 'current browser-agent-driver benchmark-webvoyager prompt and runner',
  },
  score: {
    success: c.strictPassed ? 1 : 0,
    goalProgress: progressFromLabels({ ...c, passed: c.rawPassed, verdict: c.verdict }, c.labels),
    repoGroundedness: 1,
    driftPenalty: c.labels.includes('state-reset') || c.labels.includes('explore-vs-exact-search') ? 1 : 0.4,
    toolUseQuality: c.labels.includes('calendar-date-picker') ? 0.2 : 0.45,
    patchQuality: 0,
    testReality: c.rawPassed === c.strictPassed ? 1 : 0,
    finalGate: c.strictPassed ? 1 : 0,
    reviewerBlockers: c.strictPassed ? 0 : 1,
    costUsd: c.costUsd || 0,
    wallSeconds: (c.durationMs || 0) / 1000,
    notes: c.labels,
  },
  metadata: {
    task: c.goal,
    split: c.split,
    seed_preview: c.verdict.slice(0, 500),
    labels: c.labels,
    rawPassed: c.rawPassed,
    strictPassed: c.strictPassed,
    turnsUsed: c.turnsUsed,
    tokensUsed: c.tokensUsed,
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    costUsd: c.costUsd,
    durationMs: c.durationMs,
    reportPath: c.reportPath,
  },
}));

const corpusPath = path.join(outDir, 'corpus.json');
const rowsPath = path.join(outDir, 'optimizer-rows.jsonl');
const summaryOutPath = path.join(outDir, 'summary.json');

fs.writeFileSync(corpusPath, `${JSON.stringify({ aggregate, cases }, null, 2)}\n`);
fs.writeFileSync(summaryOutPath, `${JSON.stringify(aggregate, null, 2)}\n`);
fs.writeFileSync(rowsPath, `${optimizerRows.map(row => JSON.stringify(row)).join('\n')}\n`);

console.log(JSON.stringify({
  corpusPath,
  rowsPath,
  summaryPath: summaryOutPath,
  total: aggregate.total,
  rawPassed: aggregate.rawPassed,
  strictPassed: aggregate.strictPassed,
  labelCounts: aggregate.labelCounts,
}, null, 2));
