/**
 * Vision-image clamp — the one pre-flight a screenshot needs before a vision API
 * call. PURE (Buffer in → Buffer out, no IO): the disk read lives in the
 * `vision-model` adapter, this only does pixel math, so it unit-tests with
 * synthesised PNGs and no model.
 *
 * Why it exists: corpus exemplars are FULL-PAGE captures (e.g. 1440×14739). The
 * Anthropic vision API rejects any image whose longest edge exceeds 8000px with a
 * 400 `invalid_request_error`, and it internally downscales anything past ~1568px
 * on the long edge regardless — so an un-clamped full-page screenshot either hard-
 * fails (Anthropic-family providers) or burns tokens encoding detail the model
 * never sees. Clamping the longest edge to {@link VISION_MAX_EDGE_PX} both clears
 * the hard limit AND matches the API's own effective resolution, at a fraction of
 * the base64 size.
 *
 * Fail-soft by design: an image already within the limit is returned BYTE-FOR-BYTE
 * unchanged (no decode/re-encode), and a buffer that is not decodable as PNG is
 * passed through untouched rather than thrown — the downstream model call is the
 * place a genuinely bad image surfaces, not this size guard.
 */

import { PNG } from 'pngjs'

/**
 * Longest-edge ceiling, in px. 1568 is the resolution the Anthropic vision API
 * downscales to internally, and is comfortably under its 8000px hard limit — so
 * clamping here is lossless relative to what the model would actually see while
 * cutting the encoded payload by orders of magnitude on tall captures.
 */
export const VISION_MAX_EDGE_PX = 1568

/**
 * Downscale a PNG so its longest edge is ≤ `maxEdge`, preserving aspect ratio with
 * an area-average (box) filter. Returns the ORIGINAL buffer unchanged when the
 * image is already within bounds or cannot be parsed as PNG.
 */
export function clampPngLongestEdge(buf: Buffer, maxEdge: number = VISION_MAX_EDGE_PX): Buffer {
  let png: PNG
  try {
    png = PNG.sync.read(buf)
  } catch {
    // Not a decodable PNG — leave it to the model call to reject; this guard only
    // shrinks oversized images, it does not validate them.
    return buf
  }

  const { width, height } = png
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return buf

  const scale = maxEdge / longest
  const newW = Math.max(1, Math.round(width * scale))
  const newH = Math.max(1, Math.round(height * scale))
  const out = new PNG({ width: newW, height: newH })

  // Each destination pixel averages the source rectangle it maps to. The
  // rectangles tile the source exactly, so every source pixel is read once —
  // O(source pixels), independent of the downscale factor.
  const src = png.data
  const dst = out.data
  for (let y = 0; y < newH; y++) {
    const sy0 = Math.floor((y * height) / newH)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / newH))
    for (let x = 0; x < newW; x++) {
      const sx0 = Math.floor((x * width) / newW)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / newW))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        const rowBase = sy * width
        for (let sx = sx0; sx < sx1; sx++) {
          const idx = (rowBase + sx) << 2
          r += src[idx]
          g += src[idx + 1]
          b += src[idx + 2]
          a += src[idx + 3]
          n++
        }
      }
      const o = (y * newW + x) << 2
      dst[o] = Math.round(r / n)
      dst[o + 1] = Math.round(g / n)
      dst[o + 2] = Math.round(b / n)
      dst[o + 3] = Math.round(a / n)
    }
  }
  return PNG.sync.write(out)
}
