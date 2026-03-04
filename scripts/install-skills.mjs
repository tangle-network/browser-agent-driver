#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve(path.join(new URL('.', import.meta.url).pathname, '..'));
const manifestPath = path.join(rootDir, 'skills', 'manifest.json');

if (!fs.existsSync(manifestPath)) {
  console.error(`Skills manifest not found: ${manifestPath}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outArg = outIdx >= 0 ? argv[outIdx + 1] : undefined;

const codexHome = process.env.CODEX_HOME?.trim()
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), '.codex');
const destinationRoot = path.resolve(outArg || path.join(codexHome, 'skills'));

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
  console.error('No skills defined in manifest.');
  process.exit(1);
}

fs.mkdirSync(destinationRoot, { recursive: true });

for (const skill of manifest.skills) {
  const src = path.join(rootDir, skill.path);
  const dest = path.join(destinationRoot, skill.name);
  if (!fs.existsSync(src)) {
    console.error(`Missing skill source directory: ${src}`);
    process.exit(1);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Installed: ${skill.name} -> ${dest}`);
}

console.log(`Done. Installed ${manifest.skills.length} skill(s) to ${destinationRoot}`);
