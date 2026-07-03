import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Platform-specific filename of Playwright/patchright's bundled ffmpeg binary
 * (the one its video recorder shells out to). Confirmed layout:
 * `<browsersPath>/ffmpeg-<rev>/ffmpeg-linux`.
 */
function ffmpegBinaryName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'ffmpeg-win64.exe';
  if (platform === 'darwin') return 'ffmpeg-mac';
  return 'ffmpeg-linux';
}

/**
 * Resolve the browsers cache directory Playwright/patchright downloads into.
 * Returns null when it can't be resolved cheaply (e.g. the special
 * `PLAYWRIGHT_BROWSERS_PATH=0` "store inside the package" mode).
 */
function resolveBrowsersPath(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PLAYWRIGHT_BROWSERS_PATH;
  if (explicit === '0') return null;
  if (explicit) return explicit;

  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'ms-playwright');
    case 'darwin':
      return path.join(home, 'Library', 'Caches', 'ms-playwright');
    default:
      return path.join(home, '.cache', 'ms-playwright');
  }
}

/**
 * Whether Playwright/patchright's video-recording ffmpeg binary is present.
 *
 * patchright resolves ffmpeg from `<browsersPath>/ffmpeg-<rev>/<binary>` — the
 * same `PLAYWRIGHT_BROWSERS_PATH` root as the browsers. When it is missing, a
 * context opened with `recordVideo` throws at page creation
 * ("Executable doesn't exist at .../ffmpeg-<rev>/ffmpeg-linux") and kills the
 * whole run. Detecting the absence lets the caller drop `recordVideo` and still
 * produce report + screenshots + trace.
 *
 * Bias toward `false` (disable video) on uncertainty. The failure is
 * asymmetric: a wrong "available" HARD-CRASHES the run at page creation, while a
 * wrong "unavailable" only skips the replay video. So we return `true` ONLY when
 * we can positively confirm an ffmpeg binary exists (or the browsers are bundled
 * inside the package via `PLAYWRIGHT_BROWSERS_PATH=0`, whose layout we can't
 * cheaply probe). Every other path — cache dir absent, cache dir present without
 * ffmpeg, or a probe error — returns `false`.
 *
 * This is the exact Tangle agent-thin case: Chromium is launched from Nix via
 * executablePath and `PLAYWRIGHT_BROWSERS_PATH` points at a warm npm cache
 * volume that never had `playwright install` run against it, so the browsers
 * directory does not exist. An earlier "bias toward true on a missing dir"
 * kept `recordVideo` there and crashed the run.
 *
 * Normal dev/CI is unaffected: `playwright`/`patchright install` populates the
 * cache with `ffmpeg-<rev>/<binary>`, which the positive check finds → `true`.
 */
export function isPlaywrightFfmpegAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    // Browsers (and ffmpeg) are bundled inside the installed package; we can't
    // cheaply probe that layout, so assume ffmpeg shipped alongside them.
    if (env.PLAYWRIGHT_BROWSERS_PATH === '0') return true;

    const base = resolveBrowsersPath(env);
    if (!base) return true;

    // No browsers cache directory → ffmpeg was never downloaded there. Recording
    // would crash at newPage(), so report it unavailable (agent-thin case).
    if (!fs.existsSync(base)) return false;

    const binary = ffmpegBinaryName();
    for (const entry of fs.readdirSync(base)) {
      if (entry.startsWith('ffmpeg-') && fs.existsSync(path.join(base, entry, binary))) {
        return true;
      }
    }
    // Cache dir exists but holds no ffmpeg binary.
    return false;
  } catch {
    // Probe failure → disable video (crash-avoidance bias, see above).
    return false;
  }
}

/**
 * The Playwright browsers cache directory this process would probe for ffmpeg,
 * or `null` for the package-internal (`PLAYWRIGHT_BROWSERS_PATH=0`) mode. Exposed
 * so callers can surface the resolved path in a diagnostic when video is dropped.
 */
export function playwrightBrowsersPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.PLAYWRIGHT_BROWSERS_PATH === '0') return null;
  return resolveBrowsersPath(env);
}
