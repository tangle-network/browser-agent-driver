#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import { DEFAULT_STORAGE_STATE_PATH, resolveStorageStatePath } from './lib/storage-state.mjs';

async function main() {
  const url = process.argv[2] ?? 'https://ai.tangle.tools';
  const outPath = resolveStorageStatePath(process.argv[3] ?? DEFAULT_STORAGE_STATE_PATH);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log(`Opening: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  console.log('');
  console.log('Log in manually in the opened browser window.');
  console.log(`When done, press Enter here to save storage state to: ${outPath}`);

  const rl = readline.createInterface({ input, output });
  await rl.question('Press Enter after login is complete... ');
  await rl.close();

  await context.storageState({ path: outPath });
  await browser.close();

  console.log(`Saved storage state: ${outPath}`);
  console.log(`Next: pnpm auth:check-state ${outPath} ${new URL(url).host}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
