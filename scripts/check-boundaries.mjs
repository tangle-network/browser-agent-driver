#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const srcDir = path.join(rootDir, 'src');

const rules = [
  {
    name: 'drivers-are-runtime-only',
    from: /^src\/drivers\//,
    blocked: [/^src\/brain\//, /^src\/runner\.ts$/, /^src\/cli\.ts$/, /^src\/test-runner\.ts$/],
  },
  {
    name: 'brain-does-not-depend-on-cli-or-runner',
    from: /^src\/brain\//,
    blocked: [/^src\/cli\.ts$/, /^src\/test-runner\.ts$/],
  },
  {
    name: 'artifacts-are-transport-only',
    from: /^src\/artifacts\//,
    blocked: [/^src\/brain\//, /^src\/runner\.ts$/, /^src\/cli\.ts$/, /^src\/drivers\//],
  },
];

const files = listTsFiles(srcDir);
const violations = [];

for (const absPath of files) {
  const relPath = toPosix(path.relative(rootDir, absPath));
  const content = fs.readFileSync(absPath, 'utf-8');
  const imports = parseImports(content);
  for (const specifier of imports) {
    const resolved = resolveLocalImport(absPath, specifier);
    if (!resolved) continue;
    const targetRel = toPosix(path.relative(rootDir, resolved));

    for (const rule of rules) {
      if (!rule.from.test(relPath)) continue;
      if (!rule.blocked.some((pattern) => pattern.test(targetRel))) continue;
      violations.push({
        file: relPath,
        import: specifier,
        resolved: targetRel,
        rule: rule.name,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations detected:');
  for (const violation of violations) {
    console.error(
      `- ${violation.file} imports "${violation.import}" -> ${violation.resolved} (${violation.rule})`,
    );
  }
  process.exit(1);
}

console.log(`Boundary check passed (${files.length} files).`);

function parseImports(content) {
  const specs = [];
  const importRe = /^\s*import(?:[\s\w{},*]*from\s*)?["']([^"']+)["']/gm;
  const dynamicRe = /import\(\s*["']([^"']+)["']\s*\)/gm;
  let match;
  while ((match = importRe.exec(content)) !== null) specs.push(match[1]);
  while ((match = dynamicRe.exec(content)) !== null) specs.push(match[1]);
  return specs;
}

function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [];

  candidates.push(remapSourceExt(base));
  if (!path.extname(base)) {
    candidates.push(`${base}.ts`);
    candidates.push(path.join(base, 'index.ts'));
  } else {
    const noExt = base.slice(0, base.length - path.extname(base).length);
    candidates.push(`${noExt}.ts`);
    candidates.push(path.join(base, 'index.ts'));
    candidates.push(path.join(noExt, 'index.ts'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function remapSourceExt(filePath) {
  if (filePath.endsWith('.js')) return `${filePath.slice(0, -3)}.ts`;
  if (filePath.endsWith('.mjs')) return `${filePath.slice(0, -4)}.ts`;
  if (filePath.endsWith('.cjs')) return `${filePath.slice(0, -4)}.ts`;
  return filePath;
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(abs));
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts') && !abs.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function toPosix(input) {
  return input.split(path.sep).join('/');
}
