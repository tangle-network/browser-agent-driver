import * as fs from 'node:fs';
import type { BrowserContext } from 'playwright';

export type StorageStateFile = {
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
};

/**
 * Apply a Playwright storageState file to a persistent context. Persistent
 * contexts are launched directly (no `storageState` launch option), so cookies
 * are added via the CDP-backed API and localStorage is seeded by navigating to
 * each origin and writing entries in-page. Best-effort: origins that block
 * storage writes are skipped silently.
 */
export async function applyStorageStateToPersistentContext(context: BrowserContext, storageStatePath?: string): Promise<void> {
  if (!storageStatePath) return;

  const parsed = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8')) as StorageStateFile;
  const cookies = parsed.cookies ?? [];
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const origins = parsed.origins ?? [];
  if (origins.length === 0) return;

  const existingPages = context.pages();
  const page = existingPages[0] ?? await context.newPage();
  const createdTempPage = existingPages.length === 0;

  try {
    for (const originState of origins) {
      if (!originState?.origin || !Array.isArray(originState.localStorage) || originState.localStorage.length === 0) {
        continue;
      }
      await page.goto(originState.origin, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate((entries) => {
        for (const entry of entries) {
          try {
            localStorage.setItem(entry.name, entry.value);
          } catch {
            // Best effort: some origins may block storage writes.
          }
        }
      }, originState.localStorage);
    }
  } finally {
    if (createdTempPage) {
      await page.close().catch(() => {});
    }
  }
}
