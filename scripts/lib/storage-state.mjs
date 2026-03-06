import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_STORAGE_STATE_PATH = '.auth/ai-tangle-tools.json';

export function resolveStorageStatePath(input) {
  return path.resolve(input || process.env.AI_TANGLE_STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH);
}

export function readAndValidateStorageState(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Storage state file not found: ${resolved}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  } catch (error) {
    throw new Error(`Storage state is not valid JSON: ${resolved}`);
  }

  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
  if (!Array.isArray(parsed?.cookies) || !Array.isArray(parsed?.origins)) {
    throw new Error(`Storage state must contain cookies[] and origins[]: ${resolved}`);
  }

  return {
    path: resolved,
    parsed,
    cookieCount: cookies.length,
    originCount: origins.length,
    originNames: origins
      .map((entry) => String(entry?.origin || '').trim())
      .filter(Boolean),
  };
}
