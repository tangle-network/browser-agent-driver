import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPlaywrightFfmpegAvailable } from '../src/ffmpeg-availability.js';

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

  it('returns true (uncertain) when the configured browsers path does not exist', () => {
    expect(
      isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'does-not-exist') }),
    ).toBe(true);
  });

  it('returns true (uncertain) for the special PLAYWRIGHT_BROWSERS_PATH=0 mode', () => {
    expect(isPlaywrightFfmpegAvailable({ PLAYWRIGHT_BROWSERS_PATH: '0' })).toBe(true);
  });
});
