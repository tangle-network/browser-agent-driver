#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const root = path.resolve(getArg('root', './agent-results'));
const outPath = getArg('out') ? path.resolve(getArg('out')) : undefined;

if (!fs.existsSync(root)) {
  console.error(`Root does not exist: ${root}`);
  process.exit(1);
}

function categorize(verdict = '') {
  const v = verdict.toLowerCase();
  if (v.includes('max turns')) return 'max_turns';
  if (v.includes('auth') || v.includes('unauthorized') || v.includes('login')) return 'auth_or_redirect';
  if (v.includes('redirect')) return 'auth_or_redirect';
  if (v.includes('quota') || v.includes('limit') || v.includes('modal') || v.includes('dialog')) return 'modal_or_blocker';
  if (v.includes('selector') || v.includes('pointer') || v.includes('intercept')) return 'interaction_or_selector';
  return 'other';
}

const suites = [];
const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name === 'report.json' && full.includes(`${path.sep}suite${path.sep}`)) {
      suites.push(full);
    }
  }
};
walk(root);

let total = 0;
let passed = 0;
const failuresByClass = {};
const failures = [];

for (const suitePath of suites) {
  const report = JSON.parse(fs.readFileSync(suitePath, 'utf-8'));
  for (const result of report.results ?? []) {
    total += 1;
    if (result.verified) {
      passed += 1;
      continue;
    }
    const verdict = String(result.verdict ?? result.agentResult?.reason ?? '');
    const cls = categorize(verdict);
    failuresByClass[cls] = (failuresByClass[cls] ?? 0) + 1;
    failures.push({
      class: cls,
      testId: result.testCase?.id,
      testName: result.testCase?.name,
      verdict: verdict.slice(0, 240),
      reportPath: suitePath,
    });
  }
}

const scorecard = {
  generatedAt: new Date().toISOString(),
  root,
  suiteReports: suites.length,
  totalTests: total,
  passed,
  failed: total - passed,
  passRate: total > 0 ? passed / total : 0,
  failuresByClass,
  topFailures: failures.slice(0, 20),
};

const output = JSON.stringify(scorecard, null, 2);
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);
}

console.log(output);
