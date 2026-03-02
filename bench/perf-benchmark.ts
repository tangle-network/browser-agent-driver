/**
 * Performance benchmark: measures token savings from snapshot diffing,
 * compact history, and resource blocking across repeated runs.
 *
 * Usage: npx tsx bench/perf-benchmark.ts
 */

import { chromium } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright.js';
import { Brain } from '../src/brain/index.js';
import type { PageState, Action } from '../src/types.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY');
  process.exit(1);
}

const MODEL = process.env.MODEL || 'gpt-4o';
const RUNS = parseInt(process.env.RUNS || '3', 10);
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '10', 10);
const GOAL = process.env.GOAL || `You are on Hacker News. Do the following steps IN ORDER:
1. Scroll down to see stories lower on the page
2. Click on the "More" link at the bottom to go to page 2
3. On page 2, scroll down again
4. Click on the "More" link at the bottom to go to page 3
5. Once on page 3, complete with a summary: "Navigated from page 1 to page 3 via More links"
Do NOT skip steps. Do them one at a time.`;

interface TurnMetric {
  turn: number;
  action: string;
  tokensUsed: number;
  snapshotSize: number;
  diffSize: number | null;
  durationMs: number;
}

interface RunMetric {
  run: number;
  model: string;
  turns: TurnMetric[];
  totalTokens: number;
  totalMs: number;
  blockedAnalytics: boolean;
  blockedImages: boolean;
  success: boolean;
  result?: string;
}

async function runBenchmark(
  runNum: number,
  blockResources: boolean,
): Promise<RunMetric> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const driver = new PlaywrightDriver(page, {
    captureScreenshots: true,
    screenshotQuality: 40,
  });

  if (blockResources) {
    await driver.setupResourceBlocking({
      blockAnalytics: true,
      blockImages: true,
    });
  }

  const brain = new Brain({
    provider: 'openai',
    model: MODEL,
    apiKey: OPENAI_API_KEY,
    vision: true,
    goalVerification: false,
    maxHistoryTurns: 10,
  });

  const turnMetrics: TurnMetric[] = [];
  let totalTokens = 0;
  let success = false;
  let result: string | undefined;

  // Navigate to start URL
  await page.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded' });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const turnStart = Date.now();

    // Observe
    const state: PageState = await driver.observe();
    const snapshotSize = state.snapshot.length;
    const diffSize = state.snapshotDiff ? state.snapshotDiff.length : null;

    // Decide
    let decision;
    try {
      decision = await brain.decide(GOAL, state, undefined, { current: turn, max: MAX_TURNS });
    } catch (err) {
      console.error(`  Turn ${turn}: Brain error: ${err}`);
      break;
    }

    const tokens = decision.tokensUsed ?? 0;
    totalTokens += tokens;

    const action: Action = decision.action;
    const turnDuration = Date.now() - turnStart;

    turnMetrics.push({
      turn,
      action: action.action,
      tokensUsed: tokens,
      snapshotSize,
      diffSize,
      durationMs: turnDuration,
    });

    console.log(
      `  Turn ${turn}: ${action.action.padEnd(10)} | ` +
      `tokens=${String(tokens).padStart(5)} | ` +
      `snapshot=${String(snapshotSize).padStart(5)}ch | ` +
      `diff=${diffSize !== null ? String(diffSize).padStart(4) + 'ch' : ' none'} | ` +
      `${turnDuration}ms`
    );

    // Terminal actions
    if (action.action === 'complete') {
      success = true;
      result = (action as { result: string }).result;
      break;
    }
    if (action.action === 'abort') {
      result = (action as { reason: string }).reason;
      break;
    }

    // Execute
    try {
      await driver.execute(action);
    } catch (err) {
      console.error(`  Turn ${turn}: Execute error: ${err}`);
    }
  }

  const totalMs = turnMetrics.reduce((sum, t) => sum + t.durationMs, 0);

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  return {
    run: runNum,
    model: MODEL,
    turns: turnMetrics,
    totalTokens,
    totalMs,
    blockedAnalytics: blockResources,
    blockedImages: blockResources,
    success,
    result,
  };
}

async function main() {
  console.log('=== Agent Browser Driver Performance Benchmark ===');
  console.log(`Model: ${MODEL} | Runs: ${RUNS} | Max turns: ${MAX_TURNS}`);
  console.log(`Goal: ${GOAL.split('\n')[0]}...`);
  console.log('');

  // --- Phase 1: With all optimizations ---
  console.log('========================================');
  console.log('PHASE 1: WITH optimizations (diff + compact + resource blocking)');
  console.log('========================================');
  const optimizedResults: RunMetric[] = [];
  for (let i = 1; i <= RUNS; i++) {
    console.log(`--- Optimized Run ${i}/${RUNS} ---`);
    const metric = await runBenchmark(i, true);
    optimizedResults.push(metric);
    console.log(
      `  => ${metric.success ? 'SUCCESS' : 'INCOMPLETE'} | ` +
      `${metric.turns.length} turns | ` +
      `${metric.totalTokens} total tokens | ` +
      `${Math.round(metric.totalMs / 1000)}s`
    );
    console.log('');
  }

  // --- Phase 2: Without resource blocking (diff + compact still active) ---
  console.log('========================================');
  console.log('PHASE 2: WITHOUT resource blocking (baseline page loads)');
  console.log('========================================');
  const baselineResults: RunMetric[] = [];
  for (let i = 1; i <= RUNS; i++) {
    console.log(`--- Baseline Run ${i}/${RUNS} ---`);
    const metric = await runBenchmark(i, false);
    baselineResults.push(metric);
    console.log(
      `  => ${metric.success ? 'SUCCESS' : 'INCOMPLETE'} | ` +
      `${metric.turns.length} turns | ` +
      `${metric.totalTokens} total tokens | ` +
      `${Math.round(metric.totalMs / 1000)}s`
    );
    console.log('');
  }

  // --- Comparison ---
  printResults('OPTIMIZED (blocked)', optimizedResults);
  printResults('BASELINE (no blocking)', baselineResults);

  // Comparison
  const optAvgTokens = avg(optimizedResults.map(r => r.totalTokens));
  const baseAvgTokens = avg(baselineResults.map(r => r.totalTokens));
  const optAvgMs = avg(optimizedResults.map(r => r.totalMs));
  const baseAvgMs = avg(baselineResults.map(r => r.totalMs));

  console.log('');
  console.log('=== Comparison ===');
  console.log(`Avg tokens: ${optAvgTokens} (optimized) vs ${baseAvgTokens} (baseline) → ${pctDiff(baseAvgTokens, optAvgTokens)}`);
  console.log(`Avg time:   ${Math.round(optAvgMs / 1000)}s (optimized) vs ${Math.round(baseAvgMs / 1000)}s (baseline) → ${pctDiff(baseAvgMs, optAvgMs)}`);

  // Per-turn diff analysis
  console.log('');
  console.log('=== Snapshot Diff Analysis (optimized runs) ===');
  let totalTurns = 0;
  let turnsWithDiff = 0;
  let totalDiffSize = 0;
  let totalSnapshotSize = 0;
  for (const r of optimizedResults) {
    for (const t of r.turns) {
      totalTurns++;
      totalSnapshotSize += t.snapshotSize;
      if (t.diffSize !== null) {
        turnsWithDiff++;
        totalDiffSize += t.diffSize;
      }
    }
  }
  console.log(`${turnsWithDiff}/${totalTurns} turns had snapshot diffs (${Math.round(turnsWithDiff / totalTurns * 100)}%)`);
  if (turnsWithDiff > 0) {
    console.log(`Avg diff size: ${Math.round(totalDiffSize / turnsWithDiff)} chars vs avg snapshot: ${Math.round(totalSnapshotSize / totalTurns)} chars`);
  }

  // Per-turn token trend
  console.log('');
  console.log('=== Per-Turn Token Trend (optimized, averaged) ===');
  const maxTurnsSeen = Math.max(...optimizedResults.map(r => r.turns.length));
  let prevAvgTokens = 0;
  for (let t = 1; t <= maxTurnsSeen; t++) {
    const turnsAtT = optimizedResults.map(r => r.turns.find(m => m.turn === t)).filter(Boolean) as TurnMetric[];
    if (turnsAtT.length === 0) continue;
    const avgTokens = Math.round(turnsAtT.reduce((s, m) => s + m.tokensUsed, 0) / turnsAtT.length);
    const avgDuration = Math.round(turnsAtT.reduce((s, m) => s + m.durationMs, 0) / turnsAtT.length);
    const diffs = turnsAtT.filter(m => m.diffSize !== null);
    const avgDiff = diffs.length > 0 ? Math.round(diffs.reduce((s, m) => s + m.diffSize!, 0) / diffs.length) : null;
    const delta = prevAvgTokens > 0 ? `+${avgTokens - prevAvgTokens}` : 'baseline';
    prevAvgTokens = avgTokens;
    console.log(
      `Turn ${t}: avg ${String(avgTokens).padStart(5)} tokens (${delta.padStart(7)}) | ${String(avgDuration).padStart(5)}ms | diff ${avgDiff !== null ? avgDiff + 'ch' : 'n/a'}`
    );
  }

  // Show per-turn delta analysis
  if (maxTurnsSeen >= 3) {
    const firstDelta = getAvgDelta(optimizedResults, 1, 2);
    const laterDeltas: number[] = [];
    for (let t = 2; t < maxTurnsSeen; t++) {
      laterDeltas.push(getAvgDelta(optimizedResults, t, t + 1));
    }
    const avgLaterDelta = laterDeltas.length > 0 ? Math.round(laterDeltas.reduce((a, b) => a + b, 0) / laterDeltas.length) : 0;
    console.log('');
    console.log(`History growth: turn 1→2 = +${firstDelta} tokens (full snapshot in history)`);
    console.log(`History growth: turns 2+ = avg +${avgLaterDelta} tokens (compact history active)`);
    if (firstDelta > 0 && avgLaterDelta > 0) {
      const savings = Math.round((1 - avgLaterDelta / firstDelta) * 100);
      console.log(`=> Compact history saves ~${savings}% per-turn token growth`);
    }
  }
}

function printResults(label: string, results: RunMetric[]): void {
  console.log('');
  console.log(`=== ${label} ===`);
  console.log('Run | Turns | Total Tokens | Avg Tokens/Turn | Total Time | Result');
  console.log('----|-------|-------------|-----------------|------------|-------');
  for (const r of results) {
    const avgTokens = r.turns.length > 0 ? Math.round(r.totalTokens / r.turns.length) : 0;
    console.log(
      `  ${r.run} |   ${String(r.turns.length).padStart(3)} |      ${String(r.totalTokens).padStart(6)} |          ${String(avgTokens).padStart(6)} |     ${String(Math.round(r.totalMs / 1000)).padStart(4)}s | ${r.success ? 'OK' : 'INCOMPLETE'}`
    );
  }
}

function avg(nums: number[]): number {
  return nums.length > 0 ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

function pctDiff(baseline: number, optimized: number): string {
  if (baseline === 0) return 'n/a';
  const diff = ((optimized - baseline) / baseline) * 100;
  return `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`;
}

function getAvgDelta(results: RunMetric[], fromTurn: number, toTurn: number): number {
  const deltas: number[] = [];
  for (const r of results) {
    const from = r.turns.find(t => t.turn === fromTurn);
    const to = r.turns.find(t => t.turn === toTurn);
    if (from && to) deltas.push(to.tokensUsed - from.tokensUsed);
  }
  return deltas.length > 0 ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
