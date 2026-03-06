#!/usr/bin/env node

import { readAndValidateStorageState, resolveStorageStatePath } from './lib/storage-state.mjs';

const target = resolveStorageStatePath(process.argv[2]);
const expectedOrigin = process.argv[3] || '';

try {
  const state = readAndValidateStorageState(target);
  const hasExpectedOrigin = expectedOrigin
    ? state.originNames.some((origin) => origin.includes(expectedOrigin))
    : true;

  console.log(`Storage state: ${state.path}`);
  console.log(`- cookies: ${state.cookieCount}`);
  console.log(`- origins: ${state.originCount}`);
  if (state.originNames.length > 0) {
    for (const origin of state.originNames.slice(0, 10)) {
      console.log(`- origin: ${origin}`);
    }
  }

  if (!hasExpectedOrigin) {
    console.error(`Expected origin not found in storage state: ${expectedOrigin}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
