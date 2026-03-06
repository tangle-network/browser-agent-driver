import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_STORAGE_STATE_PATH, readAndValidateStorageState, resolveStorageStatePath } from '../scripts/lib/storage-state.mjs';

describe('storage state helpers', () => {
  it('uses the default storage state path when no input is provided', () => {
    expect(resolveStorageStatePath()).toBe(path.resolve(DEFAULT_STORAGE_STATE_PATH));
  });

  it('reads and validates storage state json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abd-storage-state-'));
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, JSON.stringify({
      cookies: [{ name: 'sid', value: 'abc', domain: 'ai.tangle.tools' }],
      origins: [{ origin: 'https://ai.tangle.tools', localStorage: [] }],
    }));

    const state = readAndValidateStorageState(filePath);
    expect(state.cookieCount).toBe(1);
    expect(state.originCount).toBe(1);
    expect(state.originNames).toContain('https://ai.tangle.tools');
  });
});
