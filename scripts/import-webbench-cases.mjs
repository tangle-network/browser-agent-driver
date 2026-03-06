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

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const csvPath = path.resolve(getArg('csv', './bench/webbench/webbenchfinal.csv'));
const outPath = path.resolve(getArg('out', './bench/scenarios/cases/webbench-read-sample.json'));
const categories = String(getArg('categories', 'READ'))
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean);
const limit = Math.max(1, Number.parseInt(getArg('limit', '50'), 10));
const maxPerDomain = Math.max(1, Number.parseInt(getArg('max-per-domain', '2'), 10));
const seed = Number.parseInt(getArg('seed', '7'), 10);
const minTaskLength = Math.max(40, Number.parseInt(getArg('min-task-length', '80'), 10));
const strictDomain = getArg('strict-domain', 'true') !== 'false';

if (!fs.existsSync(csvPath)) {
  console.error(`WebBench CSV not found: ${csvPath}`);
  console.error('Download webbenchfinal.csv and place it under ./bench/webbench or pass --csv.');
  process.exit(1);
}

const raw = fs.readFileSync(csvPath, 'utf-8');
const records = parseCsv(raw);
if (records.length === 0) {
  console.error(`No records found in CSV: ${csvPath}`);
  process.exit(1);
}

const normalized = records
  .map((record) => normalizeRecord(record))
  .filter(Boolean)
  .filter((record) => categories.includes(record.category))
  .filter((record) => record.task.length >= minTaskLength);

if (normalized.length === 0) {
  console.error(`No matching tasks after filtering categories=${categories.join(',')}`);
  process.exit(1);
}

const shuffled = seededShuffle(normalized, seed);
const selected = [];
const domainCounts = new Map();

for (const record of shuffled) {
  const domain = safeDomain(record.startUrl);
  const used = domainCounts.get(domain) ?? 0;
  if (used >= maxPerDomain) continue;
  selected.push(record);
  domainCounts.set(domain, used + 1);
  if (selected.length >= limit) break;
}

const cases = selected.map((record) => toCase(record, { strictDomain }));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(cases, null, 2)}\n`);

console.log('WebBench import completed');
console.log(`- source: ${csvPath}`);
console.log(`- output: ${outPath}`);
console.log(`- selected: ${cases.length}`);
console.log(`- categories: ${categories.join(', ')}`);
console.log(`- max per domain: ${maxPerDomain}`);
console.log(`- repo root: ${rootDir}`);

function toCase(record, options) {
  const maxTurns = maxTurnsForCategory(record.category);
  const domain = safeDomain(record.startUrl);
  const constrainedTask = options.strictDomain
    ? `${record.task}\nOnly use ${domain} for this task.`
    : record.task;
  return {
    id: `webbench-${record.id}`,
    name: `WebBench ${record.category.toLowerCase()} #${record.id}`,
    startUrl: record.startUrl,
    goal: constrainedTask,
    maxTurns,
    tags: ['webbench', record.category.toLowerCase(), domain],
  };
}

function maxTurnsForCategory(category) {
  switch (category) {
    case 'READ':
      return 35;
    case 'CREATE':
    case 'UPDATE':
    case 'DELETE':
      return 60;
    case 'FILE_MANIPULATION':
      return 70;
    default:
      return 45;
  }
}

function normalizeRecord(record) {
  const id = String(record.ID ?? '').trim();
  const startUrl = String(record['Starting URL'] ?? '').trim();
  const category = String(record.Category ?? '').trim().toUpperCase();
  const task = normalizeWhitespace(String(record.Task ?? ''));
  if (!id || !startUrl || !category || !task) return null;
  if (!/^https?:\/\//i.test(startUrl)) return null;
  return { id, startUrl, category, task };
}

function normalizeWhitespace(input) {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeDomain(startUrl) {
  try {
    return new URL(startUrl).hostname;
  } catch {
    return 'unknown-domain';
  }
}

function seededShuffle(items, initialSeed) {
  const arr = [...items];
  let seedState = Number.isFinite(initialSeed) ? initialSeed : 7;
  for (let i = arr.length - 1; i > 0; i--) {
    seedState = (seedState * 1664525 + 1013904223) % 4294967296;
    const j = seedState % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushField();
      pushRow();
      continue;
    }
    if (ch === '\r') {
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map((value) => value.trim());
  return rows
    .slice(1)
    .filter((values) => values.some((value) => String(value ?? '').trim().length > 0))
    .map((values) => {
      const entry = {};
      headers.forEach((header, idx) => {
        entry[header] = values[idx] ?? '';
      });
      return entry;
    });
}
