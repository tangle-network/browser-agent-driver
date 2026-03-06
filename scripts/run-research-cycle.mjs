#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const getArg = (name, fallback = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  if (idx === argv.length - 1) return 'true';
  return argv[idx + 1];
};

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const specsInput = getArg('specs', '');
const specs = specsInput
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));

if (specs.length === 0) {
  console.error('Usage: node scripts/run-research-cycle.mjs --specs spec1.json,spec2.json[,specN.json] [--out ./agent-results/research-cycle-<ts>]');
  process.exit(1);
}

for (const specPath of specs) {
  if (!fs.existsSync(specPath)) {
    console.error(`Spec not found: ${specPath}`);
    process.exit(1);
  }
}

const outRoot = path.resolve(getArg('out', `./agent-results/research-cycle-${Date.now()}`));
fs.mkdirSync(outRoot, { recursive: true });

const rows = [];
for (let i = 0; i < specs.length; i++) {
  const specPath = specs[i];
  const slug = `${String(i + 1).padStart(2, '0')}-${path.basename(specPath, path.extname(specPath))}`;
  const runOut = path.join(outRoot, slug);
  fs.mkdirSync(runOut, { recursive: true });

  console.log(`\n[cycle] Running ${slug}`);
  const exitCode = await spawnAndWait('node', ['scripts/run-ab-experiment.mjs', '--spec', specPath, '--out', runOut], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
  });

  const summaryPath = path.join(runOut, 'summary.json');
  const summary = fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, 'utf-8'))
    : null;

  const deltaRaw = summary?.delta?.raw?.onMinusOff ?? null;
  const deltaRawCi = summary?.delta?.raw?.bootstrap95 ?? null;
  const deltaClean = summary?.delta?.clean?.onMinusOff ?? null;
  const deltaCleanCi = summary?.delta?.clean?.bootstrap95 ?? null;
  const blockedTests = Object.values(summary?.byArm ?? {}).reduce(
    (acc, arm) => acc + Number(arm?.blockedTests ?? 0),
    0,
  );
  const score = Array.isArray(deltaCleanCi) ? Number(deltaCleanCi[0]) : Number(deltaClean ?? -Infinity);
  const decision = classifyDecision(deltaCleanCi, deltaClean);

  rows.push({
    rank: 0,
    specPath,
    slug,
    runOut,
    exitCode,
    summaryPath: summaryPath,
    model: summary?.model ?? null,
    casesPath: summary?.casesPath ?? null,
    repetitions: summary?.repetitions ?? null,
    deltaRaw,
    deltaRawCi,
    deltaClean,
    deltaCleanCi,
    blockedTests,
    score,
    decision,
  });
}

const ranked = [...rows].sort((a, b) => Number(b.score ?? -Infinity) - Number(a.score ?? -Infinity));
ranked.forEach((row, index) => { row.rank = index + 1; });

const comparabilityWarnings = [];
const modelSet = new Set(rows.map((row) => String(row.model ?? 'unknown')));
const casesSet = new Set(rows.map((row) => String(row.casesPath ?? 'unknown')));
const repetitionsSet = new Set(rows.map((row) => String(row.repetitions ?? 'unknown')));
if (modelSet.size > 1) {
  comparabilityWarnings.push(`Mixed models across specs: ${[...modelSet].join(', ')}`);
}
if (casesSet.size > 1) {
  comparabilityWarnings.push('Mixed casesPath across specs; leaderboard ranking is not strictly apples-to-apples.');
}
if (repetitionsSet.size > 1) {
  comparabilityWarnings.push(`Mixed repetitions across specs: ${[...repetitionsSet].join(', ')}`);
}

const cycleSummary = {
  generatedAt: new Date().toISOString(),
  outRoot,
  totalSpecs: specs.length,
  comparabilityWarnings,
  leaderboard: ranked,
};

const summaryPath = path.join(outRoot, 'cycle-summary.json');
fs.writeFileSync(summaryPath, `${JSON.stringify(cycleSummary, null, 2)}\n`);
writeCsv(path.join(outRoot, 'cycle-leaderboard.csv'), ranked);
writeMarkdown(path.join(outRoot, 'cycle-summary.md'), cycleSummary);

console.log('\n[cycle] complete');
console.log(`- summary: ${summaryPath}`);
if (ranked.length > 0) {
  const top = ranked[0];
  console.log(`- top: ${top.slug} (${top.decision}) clean delta=${fmtPct(top.deltaClean)} ci=${fmtCi(top.deltaCleanCi)}`);
}

function classifyDecision(deltaCi, deltaMean) {
  if (Array.isArray(deltaCi) && deltaCi.length === 2) {
    if (Number(deltaCi[0]) > 0) return 'promote';
    if (Number(deltaCi[1]) < 0) return 'reject';
    return 'inconclusive';
  }
  if (Number.isFinite(deltaMean) && Number(deltaMean) > 0) return 'candidate';
  return 'inconclusive';
}

function fmtPct(value) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${(Number(value) * 100).toFixed(2)}pp`;
}

function fmtCi(ci) {
  if (!Array.isArray(ci) || ci.length !== 2) return 'n/a';
  return `${fmtPct(ci[0])} to ${fmtPct(ci[1])}`;
}

function writeCsv(filePath, rows) {
  const header = [
    'rank',
    'slug',
    'decision',
    'exitCode',
    'score',
    'deltaClean',
    'deltaCleanCiLo',
    'deltaCleanCiHi',
    'deltaRaw',
    'deltaRawCiLo',
    'deltaRawCiHi',
    'blockedTests',
    'repetitions',
    'model',
    'specPath',
    'runOut',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.rank,
      row.slug,
      row.decision,
      row.exitCode,
      row.score,
      row.deltaClean ?? '',
      Array.isArray(row.deltaCleanCi) ? row.deltaCleanCi[0] : '',
      Array.isArray(row.deltaCleanCi) ? row.deltaCleanCi[1] : '',
      row.deltaRaw ?? '',
      Array.isArray(row.deltaRawCi) ? row.deltaRawCi[0] : '',
      Array.isArray(row.deltaRawCi) ? row.deltaRawCi[1] : '',
      row.blockedTests,
      row.repetitions ?? '',
      csvEscape(row.model ?? ''),
      csvEscape(row.specPath),
      csvEscape(row.runOut),
    ].join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function writeMarkdown(filePath, summary) {
  const lines = [];
  lines.push('# Research Cycle Summary');
  lines.push('');
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Out root: \`${summary.outRoot}\``);
  lines.push(`- Specs: ${summary.totalSpecs}`);
  if (Array.isArray(summary.comparabilityWarnings) && summary.comparabilityWarnings.length > 0) {
    lines.push('- Comparability warnings:');
    for (const warning of summary.comparabilityWarnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');
  lines.push('| Rank | Spec | Decision | Clean Delta | Clean CI | Raw Delta | Raw CI | Blocked |');
  lines.push('| ---: | --- | --- | ---: | --- | ---: | --- | ---: |');
  for (const row of summary.leaderboard) {
    lines.push(
      `| ${row.rank} | \`${path.basename(row.specPath)}\` | ${row.decision} | ${fmtPct(row.deltaClean)} | ${fmtCi(row.deltaCleanCi)} | ${fmtPct(row.deltaRaw)} | ${fmtCi(row.deltaRawCi)} | ${row.blockedTests} |`,
    );
  }
  lines.push('');
  lines.push('## Files');
  lines.push('');
  lines.push('- `cycle-summary.json`');
  lines.push('- `cycle-leaderboard.csv`');
  lines.push('- `cycle-summary.md`');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function spawnAndWait(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}
