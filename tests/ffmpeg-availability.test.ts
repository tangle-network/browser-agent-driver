import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPlaywrightFfmpegAvailable, playwrightBrowsersPath } from '../src/ffmpeg-availability.js';

describe('isPlaywrightFfmpegAvailable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-ffmpeg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Create the ffmpeg binary for every platform name so the probe matches
  // regardless of the OS the test runs on.
  function seedFfmpeg(base: string, rev = 'ffmpeg-1011'): void {
    const dir = path.join(base, rev);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe']) {
      fs.writeFileSync(path.join(dir, name), '');
    }
  }

  it('returns true when the browsers cache contains an ffmpeg binary', () => {
    fs.mkdirSync(path.join(tmp, 'chromium-1228'), { recursive: true });
    seedFfmpeg(tmp);
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: tmp })).toBe(true);
  });

  it('returns false when the browsers cache exists but has no ffmpeg (agent-thin sandbox case)', () => {
    // Chromium is seeded (as in the warm cache) but ffmpeg is not.
    fs.mkdirSync(path.join(tmp, 'chromium-1228'), { recursive: true });
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: tmp })).toBe(false);
  });

  it('returns false when the ffmpeg-<rev> dir exists but the binary is missing', () => {
    fs.mkdirSync(path.join(tmp, 'ffmpeg-1011'), { recursive: true });
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: tmp })).toBe(false);
  });

  it('returns false when the configured browsers path does not exist (agent-thin case)', () => {
    // PLAYWRIGHT_BROWSERS_PATH is set but never populated (Chromium comes from
    // Nix via executablePath), so the directory is absent. Recording would crash
    // at newPage(), so the probe must report unavailable rather than optimistic.
    expect(
      isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'does-not-exist') }),
    ).toBe(false);
  });

  it('returns false when the browsers path is a file, not a directory (probe error)', () => {
    const asFile = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(asFile, '');
    // readdirSync throws ENOTDIR — the catch must bias toward disabling video.
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: asFile })).toBe(false);
  });

  it('returns true for the special PLAYWRIGHT_BROWSERS_PATH=0 (package-bundled) mode', () => {
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(true);
  });

  it('playwrightBrowsersPath echoes the configured path, or null for =0', () => {
    expect(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: tmp })).toBe(tmp);
    expect(playwrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(null);
  });
});
