#!/usr/bin/env npx tsx
/**
 * Full agent benchmark — measures end-to-end agent performance with
 * per-turn phase breakdown: observe, decide (LLM), execute.
 *
 * Requires an LLM API key. Runs real agent scenarios against local
 * test pages and external sites.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx bench/agent-bench.ts
 *   MODEL=gpt-4o OPENAI_API_KEY=sk-... npx tsx bench/agent-bench.ts
 *   DISABLE_CDP=1 npx tsx bench/agent-bench.ts   # Force Playwright fallback
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright.js';
import { Brain } from '../src/brain/index.js';
import type { PageState, Action } from '../src/types.js';

// ── Config ──────────────────────────────────────────────────────────────

const MODEL = process.env.MODEL || 'gpt-4o';
const DISABLE_CDP = process.env.DISABLE_CDP === '1';
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '8', 10);

// ── Utilities ───────────────────────────────────────────────────────────

interface TurnTiming {
  turn: number;
  observeMs: number;
  decideMs: number;
  executeMs: number;
  totalMs: number;
  tokensUsed: number;
  action: string;
  usedCdp: boolean;
  snapshotSize: number;
  refCount: number;
}

interface ScenarioResult {
  name: string;
  config: string;
  success: boolean;
  result?: string;
  turns: TurnTiming[];
  totalMs: number;
  avgObserveMs: number;
  avgDecideMs: number;
  avgExecuteMs: number;
  totalTokens: number;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

// ── Local HTTP Server ───────────────────────────────────────────────────

function startServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        'fixtures',
        req.url === '/' ? 'simple.html' : req.url!.replace(/^\//, ''),
      );
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(filePath));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port });
    });
  });
}

// ── Instrumented Runner ─────────────────────────────────────────────────

async function runScenario(
  name: string,
  configLabel: string,
  startUrl: string,
  goal: string,
  disableCdp: boolean,
  captureScreenshots: boolean,
): Promise<ScenarioResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const driver = new PlaywrightDriver(page, {
    disableCdp,
    captureScreenshots,
    screenshotQuality: 50,
  });

  const brain = new Brain({
    provider: 'openai',
    model: MODEL,
    vision: captureScreenshots,
  });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  const turnTimings: TurnTiming[] = [];
  const scenarioStart = performance.now();

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const turnStart = performance.now();

    // ── Observe ──
    const observeStart = performance.now();
    const state: PageState = await driver.observe();
    const observeMs = performance.now() - observeStart;
    const timing = driver.getLastTiming();

    // ── Decide (LLM) ──
    const decideStart = performance.now();
    const decision = await brain.decide(goal, state, undefined, { current: turn, max: MAX_TURNS });
    const decideMs = performance.now() - decideStart;

    const action: Action = decision.action;

    // ── Execute ──
    const executeStart = performance.now();
    if (action.action !== 'complete' && action.action !== 'abort' && action.action !== 'evaluate') {
      await driver.execute(action);
    }
    const executeMs = performance.now() - executeStart;

    turnTimings.push({
      turn,
      observeMs,
      decideMs,
      executeMs,
      totalMs: performance.now() - turnStart,
      tokensUsed: decision.tokensUsed || 0,
      action: action.action + (action.action === 'click' || action.action === 'type' ? ` ${(action as any).selector?.slice(0, 20)}` : ''),
      usedCdp: timing?.usedCdp ?? false,
      snapshotSize: timing?.snapshotSize ?? state.snapshot.length,
      refCount: timing?.refCount ?? 0,
    });

    process.stdout.write(`    T${turn}: ${formatMs(observeMs)} obs + ${formatMs(decideMs)} llm + ${formatMs(executeMs)} exec = ${formatMs(performance.now() - turnStart)} | ${action.action}\n`);

    // Check for terminal actions
    if (action.action === 'complete' || action.action === 'abort') {
      break;
    }

    // Small delay for page transitions
    if (action.action === 'navigate' || action.action === 'click') {
      await page.waitForTimeout(200);
    }
  }

  const totalMs = performance.now() - scenarioStart;

  await driver.close();
  await page.close();
  await context.close();
  await browser.close();

  const avgObserveMs = turnTimings.reduce((s, t) => s + t.observeMs, 0) / turnTimings.length;
  const avgDecideMs = turnTimings.reduce((s, t) => s + t.decideMs, 0) / turnTimings.length;
  const avgExecuteMs = turnTimings.reduce((s, t) => s + t.executeMs, 0) / turnTimings.length;
  const totalTokens = turnTimings.reduce((s, t) => s + t.tokensUsed, 0);

  const lastAction = turnTimings[turnTimings.length - 1]?.action ?? '';
  const success = lastAction.startsWith('complete');

  return {
    name,
    config: configLabel,
    success,
    result: success ? 'Completed' : `Stopped at turn ${turnTimings.length}`,
    turns: turnTimings,
    totalMs,
    avgObserveMs,
    avgDecideMs,
    avgExecuteMs,
    totalTokens,
  };
}

// ── Output ──────────────────────────────────────────────────────────────

function printComparison(cdpResult: ScenarioResult, pwResult: ScenarioResult): void {
  console.log(`\n  Scenario: ${cdpResult.name}`);
  console.log(`  Model: ${MODEL} | Max turns: ${MAX_TURNS}`);
  console.log(`  ${'─'.repeat(70)}`);

  const header = `  ${pad('Metric', 25)} ${pad('CDP', 15)} ${pad('Playwright', 15)} ${pad('Savings', 15)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(70)}`);

  const rows = [
    ['Total time', formatMs(cdpResult.totalMs), formatMs(pwResult.totalMs), formatMs(pwResult.totalMs - cdpResult.totalMs)],
    ['Avg observe()', formatMs(cdpResult.avgObserveMs), formatMs(pwResult.avgObserveMs), formatMs(pwResult.avgObserveMs - cdpResult.avgObserveMs)],
    ['Avg decide()', formatMs(cdpResult.avgDecideMs), formatMs(pwResult.avgDecideMs), formatMs(pwResult.avgDecideMs - cdpResult.avgDecideMs)],
    ['Avg execute()', formatMs(cdpResult.avgExecuteMs), formatMs(pwResult.avgExecuteMs), formatMs(pwResult.avgExecuteMs - cdpResult.avgExecuteMs)],
    ['Turns used', String(cdpResult.turns.length), String(pwResult.turns.length), ''],
    ['Total tokens', String(cdpResult.totalTokens), String(pwResult.totalTokens), `${((1 - cdpResult.totalTokens / Math.max(pwResult.totalTokens, 1)) * 100).toFixed(0)}% fewer`],
    ['Success', cdpResult.success ? 'Yes' : 'No', pwResult.success ? 'Yes' : 'No', ''],
  ];

  for (const [label, cdp, pw, savings] of rows) {
    console.log(`  ${pad(label, 25)} ${pad(cdp, 15)} ${pad(pw, 15)} ${pad(savings, 15)}`);
  }

  // Time budget breakdown
  const cdpObsPct = (cdpResult.avgObserveMs / (cdpResult.totalMs / cdpResult.turns.length) * 100).toFixed(0);
  const cdpLlmPct = (cdpResult.avgDecideMs / (cdpResult.totalMs / cdpResult.turns.length) * 100).toFixed(0);
  const pwObsPct = (pwResult.avgObserveMs / (pwResult.totalMs / pwResult.turns.length) * 100).toFixed(0);
  const pwLlmPct = (pwResult.avgDecideMs / (pwResult.totalMs / pwResult.turns.length) * 100).toFixed(0);

  console.log(`\n  Time budget (% of turn):`);
  console.log(`    CDP:        observe ${cdpObsPct}% | LLM ${cdpLlmPct}% | execute ${100 - parseInt(cdpObsPct) - parseInt(cdpLlmPct)}%`);
  console.log(`    Playwright: observe ${pwObsPct}% | LLM ${pwLlmPct}% | execute ${100 - parseInt(pwObsPct) - parseInt(pwLlmPct)}%`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nAgent Benchmark — Model: ${MODEL} | CDP: ${DISABLE_CDP ? 'OFF' : 'ON'} | Max turns: ${MAX_TURNS}\n`);

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  const scenarios = [
    {
      name: 'Login form fill (simple)',
      url: `${baseUrl}/simple.html`,
      goal: 'Fill in the email field with "test@example.com", the password field with "secret123", then click "Sign in".',
    },
    {
      name: 'Dashboard interaction (complex)',
      url: `${baseUrl}/complex.html`,
      goal: 'Click the "Users" tab, then click "Edit" on Alice Johnson\'s row, then click the "Export" button.',
    },
    {
      name: 'Multi-step form (form)',
      url: `${baseUrl}/form.html`,
      goal: 'Fill in first name "John" and last name "Doe", click Next, fill email "john@example.com", click Next, check "I agree to the Terms of Service", then click "Create Account".',
    },
  ];

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`\n  === ${scenario.name} (CDP) ===`);
    const cdpResult = await runScenario(
      scenario.name, 'CDP', scenario.url, scenario.goal,
      false, false, // CDP enabled, no screenshots for speed
    );
    results.push(cdpResult);

    console.log(`\n  === ${scenario.name} (Playwright) ===`);
    const pwResult = await runScenario(
      scenario.name, 'Playwright', scenario.url, scenario.goal,
      true, false, // CDP disabled, no screenshots for speed
    );
    results.push(pwResult);

    printComparison(cdpResult, pwResult);
  }

  // ── Summary ───────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(72)}`);
  console.log('  SUMMARY');
  console.log('='.repeat(72));

  const cdpResults = results.filter((r) => r.config === 'CDP');
  const pwResults = results.filter((r) => r.config === 'Playwright');

  const cdpTotalMs = cdpResults.reduce((s, r) => s + r.totalMs, 0);
  const pwTotalMs = pwResults.reduce((s, r) => s + r.totalMs, 0);
  const cdpAvgObs = cdpResults.reduce((s, r) => s + r.avgObserveMs, 0) / cdpResults.length;
  const pwAvgObs = pwResults.reduce((s, r) => s + r.avgObserveMs, 0) / pwResults.length;
  const cdpTokens = cdpResults.reduce((s, r) => s + r.totalTokens, 0);
  const pwTokens = pwResults.reduce((s, r) => s + r.totalTokens, 0);

  console.log(`  Total time:     CDP ${formatMs(cdpTotalMs)} vs Playwright ${formatMs(pwTotalMs)} (${formatMs(pwTotalMs - cdpTotalMs)} saved)`);
  console.log(`  Avg observe():  CDP ${formatMs(cdpAvgObs)} vs Playwright ${formatMs(pwAvgObs)} (${((1 - cdpAvgObs / pwAvgObs) * 100).toFixed(0)}% faster)`);
  console.log(`  Total tokens:   CDP ${cdpTokens} vs Playwright ${pwTokens}`);
  console.log(`  CDP success:    ${cdpResults.filter((r) => r.success).length}/${cdpResults.length}`);
  console.log(`  PW success:     ${pwResults.filter((r) => r.success).length}/${pwResults.length}`);

  // ── Save results ──────────────────────────────────────────────────

  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `agent-bench-${MODEL}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    model: MODEL,
    maxTurns: MAX_TURNS,
    results: results.map((r) => ({
      ...r,
      turns: r.turns,
    })),
  }, null, 2));
  console.log(`\n  Results saved to: ${outFile}`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
