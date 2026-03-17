/**
 * Frame assembly — combine screenshot sequence into GIF or video.
 *
 * Uses ffmpeg-static which is already a dependency (unused until now).
 * Falls back gracefully if ffmpeg is not available.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ShowcaseFrame } from './types.js'

let ffmpegPath: string | null = null

function getFfmpeg(): string | null {
  if (ffmpegPath !== null) return ffmpegPath
  try {
    // ffmpeg-static exports the path to the binary
    ffmpegPath = require('ffmpeg-static') as string
    if (!fs.existsSync(ffmpegPath)) ffmpegPath = null
  } catch {
    // Try system ffmpeg
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      ffmpegPath = 'ffmpeg'
    } catch {
      ffmpegPath = null
    }
  }
  return ffmpegPath
}

/**
 * Assemble PNG frames into an animated GIF.
 *
 * @param frames - Ordered screenshot frames
 * @param outputPath - Where to write the GIF
 * @param opts - Frame rate, loop count
 * @returns true if successful, false if ffmpeg unavailable
 */
export function assembleGif(
  frames: ShowcaseFrame[],
  outputPath: string,
  opts?: {
    /** Frames per second. Default: 1 (1 frame per second — slideshow style). */
    fps?: number
    /** Number of loops. 0 = infinite. Default: 0. */
    loop?: number
    /** Max width in px. Frames are scaled down if wider. Default: 1200. */
    maxWidth?: number
  },
): boolean {
  const ffmpeg = getFfmpeg()
  if (!ffmpeg || frames.length === 0) return false

  const fps = opts?.fps ?? 1
  const loop = opts?.loop ?? 0
  const maxWidth = opts?.maxWidth ?? 1200

  // Write frames to temp dir
  const tmpDir = path.join(path.dirname(outputPath), '.gif-frames')
  fs.mkdirSync(tmpDir, { recursive: true })

  for (let i = 0; i < frames.length; i++) {
    fs.writeFileSync(path.join(tmpDir, `frame-${String(i).padStart(4, '0')}.png`), frames[i].buffer)
  }

  try {
    execFileSync(ffmpeg, [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(tmpDir, 'frame-%04d.png'),
      '-vf', `scale='min(${maxWidth},iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
      '-loop', String(loop),
      outputPath,
    ], { stdio: 'pipe', timeout: 60_000 })

    return true
  } catch {
    return false
  } finally {
    // Clean up temp frames
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Assemble PNG frames into a WebM video.
 */
export function assembleVideo(
  frames: ShowcaseFrame[],
  outputPath: string,
  opts?: {
    fps?: number
    maxWidth?: number
  },
): boolean {
  const ffmpeg = getFfmpeg()
  if (!ffmpeg || frames.length === 0) return false

  const fps = opts?.fps ?? 1
  const maxWidth = opts?.maxWidth ?? 1440

  const tmpDir = path.join(path.dirname(outputPath), '.video-frames')
  fs.mkdirSync(tmpDir, { recursive: true })

  for (let i = 0; i < frames.length; i++) {
    fs.writeFileSync(path.join(tmpDir, `frame-${String(i).padStart(4, '0')}.png`), frames[i].buffer)
  }

  try {
    execFileSync(ffmpeg, [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(tmpDir, 'frame-%04d.png'),
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-c:v', 'libvpx-vp9',
      '-crf', '30',
      '-b:v', '0',
      '-pix_fmt', 'yuva420p',
      outputPath,
    ], { stdio: 'pipe', timeout: 60_000 })

    return true
  } catch {
    return false
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
