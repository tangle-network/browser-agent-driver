#!/usr/bin/env npx tsx
/**
 * Observe-only benchmark — measures pure browser observation speed.
 *
 * No LLM API key needed. Spins up a local HTTP server with test fixtures,
 * runs observe() against them with different configurations, and outputs
 * phase-level timing comparisons.
 *
 * Usage:
 *   npx tsx bench/observe-bench.ts
 *   ITERATIONS=20 npx tsx bench/observe-bench.ts
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright.js';
import type { ObserveTiming } from '../src/drivers/playwright.js';

// ── Config ──────────────────────────────────────────────────────────────

const ITERATIONS = parseInt(process.env.ITERATIONS || '10', 10);
const WARMUP = 2; // Warmup iterations (discarded)

// ── Utilities ───────────────────────────────────────────────────────────

interface Stats {
  mean: number;
  median: number;
  p95: number;
  min: number;
  max: number;
  stddev: number;
}

function computeStats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    mean: Math.round(mean * 100) / 100,
    median: sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)],
    min: sorted[0],
    max: sorted[n - 1],
    stddev: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
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

// ── Benchmark Runner ────────────────────────────────────────────────────

interface BenchmarkConfig {
  name: string;
  disableCdp: boolean;
  captureScreenshots: boolean;
}

interface BenchmarkResult {
  config: BenchmarkConfig;
  page: string;
  timings: ObserveTiming[];
  totalStats: Stats;
  snapshotStats: Stats;
  screenshotStats: Stats;
  waitStats: Stats;
}

async function runBenchmark(
  config: BenchmarkConfig,
  pageUrl: string,
  pageName: string,
  iterations: number,
): Promise<BenchmarkResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const driver = new PlaywrightDriver(page, {
    disableCdp: config.disableCdp,
    captureScreenshots: config.captureScreenshots,
    screenshotQuality: 50,
  });

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await driver.observe();
  }

  // Measured iterations
  const timings: ObserveTiming[] = [];
  for (let i = 0; i < iterations; i++) {
    await driver.observe();
    const t = driver.getLastTiming();
    if (t) timings.push(t);
  }

  await driver.close();
  await page.close();
  await context.close();
  await browser.close();

  return {
    config,
    page: pageName,
    timings,
    totalStats: computeStats(timings.map((t) => t.totalMs)),
    snapshotStats: computeStats(timings.map((t) => t.snapshotMs)),
    screenshotStats: computeStats(timings.map((t) => t.screenshotMs)),
    waitStats: computeStats(timings.map((t) => t.waitForLoadMs)),
  };
}

// ── Output ──────────────────────────────────────────────────────────────

function printHeader(title: string): void {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function printComparison(cdpResult: BenchmarkResult, pwResult: BenchmarkResult): void {
  const speedup = pwResult.totalStats.mean / cdpResult.totalStats.mean;
  const savedMs = pwResult.totalStats.mean - cdpResult.totalStats.mean;

  console.log(`\n  Page: ${cdpResult.page} | Screenshots: ${cdpResult.config.captureScreenshots ? 'ON' : 'OFF'}`);
  console.log(`  ${'-'.repeat(66)}`);

  const header = `  ${pad('Phase', 20)} ${pad('CDP (ms)', 14)} ${pad('Playwright (ms)', 18)} ${pad('Speedup', 10)}`;
  console.log(header);
  console.log(`  ${'-'.repeat(66)}`);

  const phases: Array<{ name: string; cdp: Stats; pw: Stats }> = [
    { name: 'Total', cdp: cdpResult.totalStats, pw: pwResult.totalStats },
    { name: 'Snapshot/AX Tree', cdp: cdpResult.snapshotStats, pw: pwResult.snapshotStats },
    { name: 'Screenshot', cdp: cdpResult.screenshotStats, pw: pwResult.screenshotStats },
    { name: 'Wait/Load', cdp: cdpResult.waitStats, pw: pwResult.waitStats },
  ];

  for (const phase of phases) {
    const s = phase.pw.mean > 0 ? (phase.pw.mean / Math.max(phase.cdp.mean, 0.01)).toFixed(1) + 'x' : '-';
    console.log(
      `  ${pad(phase.name, 20)} ${pad(formatMs(phase.cdp.mean), 14)} ${pad(formatMs(phase.pw.mean), 18)} ${pad(s, 10)}`,
    );
  }

  console.log(`  ${'-'.repeat(66)}`);
  console.log(`  CDP saves ${formatMs(savedMs)} per observe() (${speedup.toFixed(1)}x faster)`);

  // Snapshot info from first timing
  if (cdpResult.timings[0] && pwResult.timings[0]) {
    console.log(`  CDP refs: ${cdpResult.timings[0].refCount} | PW refs: ${pwResult.timings[0].refCount}`);
    console.log(`  CDP snapshot: ${cdpResult.timings[0].snapshotSize} chars | PW snapshot: ${pwResult.timings[0].snapshotSize} chars`);
  }
}

function printDetailedStats(result: BenchmarkResult): void {
  console.log(`\n  ${result.config.name} — ${result.page}`);
  console.log(`  ${'·'.repeat(50)}`);
  const s = result.totalStats;
  console.log(`  Total: mean=${formatMs(s.mean)} median=${formatMs(s.median)} p95=${formatMs(s.p95)} stddev=${formatMs(s.stddev)}`);
  console.log(`  Range: ${formatMs(s.min)} — ${formatMs(s.max)}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nObserve() Benchmark — ${ITERATIONS} iterations + ${WARMUP} warmup per config\n`);

  const { server, port } = await startServer();
  const baseUrl = `http://localhost:${port}`;

  const pages = [
    { name: 'Simple (~10 elements)', path: 'simple.html' },
    { name: 'Complex Dashboard (~60 elements)', path: 'complex.html' },
    { name: 'Multi-Step Form (~40 elements)', path: 'form.html' },
  ];

  const configs: BenchmarkConfig[] = [
    { name: 'CDP + Screenshot', disableCdp: false, captureScreenshots: true },
    { name: 'Playwright + Screenshot', disableCdp: true, captureScreenshots: true },
    { name: 'CDP (no screenshot)', disableCdp: false, captureScreenshots: false },
    { name: 'Playwright (no screenshot)', disableCdp: true, captureScreenshots: false },
  ];

  const results: BenchmarkResult[] = [];

  for (const page of pages) {
    for (const config of configs) {
      process.stdout.write(`  Running: ${config.name} on ${page.name}...`);
      const result = await runBenchmark(config, `${baseUrl}/${page.path}`, page.name, ITERATIONS);
      results.push(result);
      process.stdout.write(` ${formatMs(result.totalStats.mean)} avg\n`);
    }
  }

  // ── Comparisons ─────────────────────────────────────────────────────

  printHeader('CDP vs Playwright — Per-Phase Breakdown');

  for (const page of pages) {
    // With screenshots
    const cdpSS = results.find((r) => r.page === page.name && !r.config.disableCdp && r.config.captureScreenshots)!;
    const pwSS = results.find((r) => r.page === page.name && r.config.disableCdp && r.config.captureScreenshots)!;
    printComparison(cdpSS, pwSS);

    // Without screenshots
    const cdpNoSS = results.find((r) => r.page === page.name && !r.config.disableCdp && !r.config.captureScreenshots)!;
    const pwNoSS = results.find((r) => r.page === page.name && r.config.disableCdp && !r.config.captureScreenshots)!;
    printComparison(cdpNoSS, pwNoSS);
  }

  // ── Screenshot Impact ─────────────────────────────────────────────

  printHeader('Screenshot Impact on CDP Path');

  for (const page of pages) {
    const withSS = results.find((r) => r.page === page.name && !r.config.disableCdp && r.config.captureScreenshots)!;
    const noSS = results.find((r) => r.page === page.name && !r.config.disableCdp && !r.config.captureScreenshots)!;
    const ssCost = withSS.totalStats.mean - noSS.totalStats.mean;
    console.log(`  ${page.name}: screenshot adds ${formatMs(ssCost)} (${((ssCost / withSS.totalStats.mean) * 100).toFixed(0)}% of total)`);
  }

  // ── Per-Turn Savings Projection ───────────────────────────────────

  printHeader('Per-Turn Savings Projection (10-turn scenario)');

  const complexCdp = results.find((r) => r.page.includes('Complex') && !r.config.disableCdp && r.config.captureScreenshots)!;
  const complexPw = results.find((r) => r.page.includes('Complex') && r.config.disableCdp && r.config.captureScreenshots)!;
  const savingsPerTurn = complexPw.totalStats.mean - complexCdp.totalStats.mean;

  console.log(`  Complex page (with screenshots):`);
  console.log(`    Playwright observe():  ${formatMs(complexPw.totalStats.mean)} per turn`);
  console.log(`    CDP observe():         ${formatMs(complexCdp.totalStats.mean)} per turn`);
  console.log(`    Savings:               ${formatMs(savingsPerTurn)} per turn`);
  console.log(`    10-turn scenario:      ${formatMs(savingsPerTurn * 10)} total saved`);
  console.log(`    20-turn scenario:      ${formatMs(savingsPerTurn * 20)} total saved`);

  // ── Detailed Stats ────────────────────────────────────────────────

  printHeader('Detailed Statistics');
  for (const result of results) {
    printDetailedStats(result);
  }

  // ── JSON Output ───────────────────────────────────────────────────

  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `observe-bench-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        iterations: ITERATIONS,
        warmup: WARMUP,
        results: results.map((r) => ({
          config: r.config,
          page: r.page,
          stats: {
            total: r.totalStats,
            snapshot: r.snapshotStats,
            screenshot: r.screenshotStats,
            wait: r.waitStats,
          },
          sample: {
            snapshotSize: r.timings[0]?.snapshotSize,
            refCount: r.timings[0]?.refCount,
            usedCdp: r.timings[0]?.usedCdp,
          },
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n  Results saved to: ${outFile}`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
