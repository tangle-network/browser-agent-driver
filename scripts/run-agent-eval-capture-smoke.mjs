#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startStaticFixtureServer } from './lib/static-fixture-server.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const outDir = path.resolve(getArg('out', `./agent-results/agent-eval-capture-smoke-${Date.now()}`));
const captureDir = path.join(outDir, '_agent-eval-capture');

if (!fs.existsSync(path.join(rootDir, 'dist', 'cli.js'))) {
  throw new Error('dist/cli.js is missing. Run pnpm build before the capture smoke.');
}

const fixtureServer = await startStaticFixtureServer(path.join(rootDir, 'bench', 'fixtures'));
const providerServer = await startFakeOpenAiServer();

try {
  fs.mkdirSync(outDir, { recursive: true });
  const status = await runChild(
    'node',
    [
      'scripts/run-mode-baseline.mjs',
      '--url', `${fixtureServer.baseUrl}/simple.html`,
      '--goal', 'Confirm the Simple Test Page fixture is visible and report the page title.',
      '--modes', 'full-evidence',
      '--model', 'gpt-5.4',
      '--provider', 'openai',
      '--base-url', `${providerServer.baseUrl}/v1`,
      '--api-key', 'sk-agent-eval-capture-smoke',
      '--out', outDir,
      '--max-turns', '3',
      '--timeout-ms', '120000',
      '--headless',
      '--agent-eval-scenario-id', 'agent-eval-capture-smoke',
      '--agent-eval-candidate-id', 'baseline',
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        BAD_AGENT_EVAL_CAPTURE_DIR: captureDir,
        BAD_AGENT_EVAL_CAPTURE_REQUIRE: '1',
        BAD_NO_WARMUP: '1',
        ABD_BENCHMARK_SYNC: '0',
      },
      stdio: 'inherit',
    },
  );

  if (status !== 0) {
    process.exit(status);
  }

  const summaryPath = path.join(outDir, 'baseline-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
  const checks = summary.agentEvalCaptureChecks ?? [];
  if (!checks.some((check) => check.rawProviderEvents > 0 && check.traceRows > 0)) {
    throw new Error(`capture smoke produced no strict capture evidence: ${summaryPath}`);
  }

  console.log(`agent-eval capture smoke passed: ${summaryPath}`);
} finally {
  await Promise.allSettled([
    fixtureServer.close(),
    providerServer.close(),
  ]);
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function startFakeOpenAiServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${req.url}` } }));
        return;
      }

      const content = chooseCompletion(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl-smoke-${requests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4-smoke',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content },
        }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 24,
          total_tokens: 144,
        },
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function chooseCompletion(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = {};
  }
  const text = JSON.stringify(body.messages ?? []);
  if (text.includes('Verify whether the browser agent achieved its goal')) {
    return JSON.stringify({
      achieved: true,
      confidence: 0.99,
      evidence: ['The current page is the Simple Test Page fixture and the claimed title matches the page.'],
      missing: [],
    });
  }

  return JSON.stringify({
    plan: ['Confirm the fixture page is visible'],
    currentStep: 0,
    action: {
      action: 'complete',
      result: 'The Simple Test Page fixture is visible. Page title: Simple Page - Benchmark Fixture.',
    },
    reasoning: 'The current page shows the Simple Test Page fixture, so the requested confirmation can be completed.',
    expectedEffect: 'The run should finish with the visible fixture title reported.',
  });
}
