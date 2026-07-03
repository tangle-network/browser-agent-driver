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
 * same `PLAYWRIGHT_BROWSERS_PATH` root as the browsers. The Tangle sandbox's
 * agent-thin runtime seeds that warm cache with Chromium but NOT ffmpeg, so a
 * context opened with `recordVideo` throws at page creation
 * ("Executable doesn't exist at .../ffmpeg-<rev>/ffmpeg-linux") and kills the
 * whole run. Detecting the absence lets the caller drop `recordVideo` and still
 * produce report + screenshots + trace.
 *
 * Bias toward `true`: we only return `false` when we can POSITIVELY confirm the
 * browsers directory exists but contains no ffmpeg (the exact sandbox case). On
 * any uncertainty — path unset/unresolvable/missing, or a probe error — we
 * return `true` so normal dev/CI, where `playwright install` provides ffmpeg,
 * keeps recording video unchanged.
 */
export function isPlaywrightFfmpegAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const base = resolveBrowsersPath(env);
    // Uncertain root → don't disable video.
    if (!base || !fs.existsSync(base)) return true;

    const binary = ffmpegBinaryName();
    for (const entry of fs.readdirSync(base)) {
      if (entry.startsWith('ffmpeg-') && fs.existsSync(path.join(base, entry, binary))) {
        return true;
      }
    }
    // Browsers dir present but no ffmpeg — the agent-thin sandbox case.
    return false;
  } catch {
    // Never let detection failure break browser launch.
    return true;
  }
}
