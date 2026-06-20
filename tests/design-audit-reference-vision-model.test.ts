import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import {
  refToId,
  createBrainVisionModel,
  type VisionCompletionModel,
} from '../src/design/audit/reference/judge/vision-model.js'
import { VISION_MAX_EDGE_PX } from '../src/design/audit/reference/judge/image-clamp.js'
import { resolveDefaultProvider } from '../src/provider-defaults.js'
import type { ModelRef, VisionImageRef } from '../src/design/audit/reference/contracts.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Solid-colour PNG bytes, exactly as they would sit on disk. */
const pngBytes = (w: number, h: number, rgb: [number, number, number] = [10, 20, 30]): Buffer => {
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) {
    const o = i << 2
    png.data[o] = rgb[0]
    png.data[o + 1] = rgb[1]
    png.data[o + 2] = rgb[2]
    png.data[o + 3] = 255
  }
  return PNG.sync.write(png)
}

interface Captured {
  system: string
  user: string
  images: ReadonlyArray<{ image: string; mediaType: string }>
  options?: { maxOutputTokens?: number }
}

/**
 * A deterministic `VisionCompletionModel` — captures exactly what the adapter
 * forwarded and returns a canned round-trip. No Brain, no network.
 */
function fakeBrain(
  ret: { text: string; tokensUsed?: number } = { text: 'verdict', tokensUsed: 7 },
): VisionCompletionModel & { calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    async completeVision(system, user, images, options) {
      calls.push({ system, user, images, options })
      return ret
    },
  }
}

// ── refToId ──────────────────────────────────────────────────────────────────

describe('refToId', () => {
  it('renders an explicit ref as provider:model', () => {
    expect(refToId({ provider: 'anthropic', model: 'claude-opus-4-8' })).toBe('anthropic:claude-opus-4-8')
    expect(refToId({ provider: 'openai', model: 'gpt-5.4' })).toBe('openai:gpt-5.4')
  })

  it('fills the ambient default provider when the ref omits one', () => {
    const original = process.env.OPENAI_API_KEY
    try {
      // OPENAI_API_KEY present ⇒ resolveDefaultProvider() === 'openai'.
      process.env.OPENAI_API_KEY = 'sk-test'
      expect(resolveDefaultProvider()).toBe('openai')
      expect(refToId({ model: 'gpt-5.4' })).toBe('openai:gpt-5.4')

      // Absent ⇒ the keyless default backend.
      delete process.env.OPENAI_API_KEY
      expect(resolveDefaultProvider()).toBe('claude-code')
      expect(refToId({ model: 'gpt-5.4' })).toBe('claude-code:gpt-5.4')
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }
  })
})

// ── createBrainVisionModel ───────────────────────────────────────────────────

describe('createBrainVisionModel', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'bad-vision-model-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const ref: ModelRef = { provider: 'openai', model: 'gpt-5.4' }

  it('exposes the ref-derived id', () => {
    const model = createBrainVisionModel(fakeBrain(), ref)
    expect(model.id).toBe('openai:gpt-5.4')
  })

  it('resolves a screenshotPath ref from disk and forwards prompts + options + return verbatim', async () => {
    // In-bounds PNG ⇒ the clamp is a byte-for-byte no-op, so the forwarded base64
    // is exactly the file bytes encoded — a clean equality to assert against.
    const buf = pngBytes(8, 8)
    const shotPath = path.join(dir, 'page.png')
    await writeFile(shotPath, buf)
    const expectedB64 = readFileSync(shotPath).toString('base64')

    const brain = fakeBrain({ text: '{"winner":"A"}', tokensUsed: 99 })
    const model = createBrainVisionModel(brain, ref)

    const out = await model.completeVision(
      'SYS',
      'USR',
      [{ screenshotPath: shotPath }],
      { maxOutputTokens: 256 },
    )

    // Return value is forwarded untouched.
    expect(out).toEqual({ text: '{"winner":"A"}', tokensUsed: 99 })
    // Exactly one round-trip with the prompts + options threaded through.
    expect(brain.calls.length).toBe(1)
    expect(brain.calls[0].system).toBe('SYS')
    expect(brain.calls[0].user).toBe('USR')
    expect(brain.calls[0].options).toEqual({ maxOutputTokens: 256 })
    // The disk image is resolved to encoded bytes with a PNG mediaType.
    expect(brain.calls[0].images).toEqual([{ image: expectedB64, mediaType: 'image/png' }])
  })

  it('preserves slot order A,B across multiple screenshots', async () => {
    const aPath = path.join(dir, 'a.png')
    const bPath = path.join(dir, 'b.png')
    await writeFile(aPath, pngBytes(8, 8, [1, 1, 1]))
    await writeFile(bPath, pngBytes(8, 8, [2, 2, 2]))

    const brain = fakeBrain()
    const model = createBrainVisionModel(brain, ref)
    await model.completeVision('s', 'u', [{ screenshotPath: aPath }, { screenshotPath: bPath }])

    expect(brain.calls[0].images.map((i) => i.image)).toEqual([
      readFileSync(aPath).toString('base64'),
      readFileSync(bPath).toString('base64'),
    ])
  })

  it('infers a non-PNG mediaType from the extension and passes those bytes through unclamped', async () => {
    // A .jpg path is treated as image/jpeg; the clamp only touches PNGs, so the
    // raw bytes are forwarded as-is (no decode/re-encode). Arbitrary bytes suffice
    // because the non-PNG branch never parses them.
    const jpgPath = path.join(dir, 'shot.jpg')
    const raw = Buffer.from('not-really-a-jpeg-but-thats-fine', 'utf8')
    await writeFile(jpgPath, raw)

    const brain = fakeBrain()
    const model = createBrainVisionModel(brain, ref)
    await model.completeVision('s', 'u', [{ screenshotPath: jpgPath }])

    expect(brain.calls[0].images).toEqual([
      { image: raw.toString('base64'), mediaType: 'image/jpeg' },
    ])
  })

  it('forwards an in-memory non-PNG base64 ref unchanged (no disk, no clamp)', async () => {
    const brain = fakeBrain()
    const model = createBrainVisionModel(brain, ref)
    const inMemory: VisionImageRef = { base64: 'QUJD', mediaType: 'image/webp' }
    await model.completeVision('s', 'u', [inMemory])

    expect(brain.calls[0].images).toEqual([{ image: 'QUJD', mediaType: 'image/webp' }])
  })

  it('clamps an oversized in-memory PNG base64 under the vision longest-edge limit', async () => {
    // 40×4000 ⇒ long edge 4000 > 1568; the adapter must shrink it before sending.
    const oversized = pngBytes(40, 4000).toString('base64')
    const brain = fakeBrain()
    const model = createBrainVisionModel(brain, ref)
    await model.completeVision('s', 'u', [{ base64: oversized, mediaType: 'image/png' }])

    const forwarded = brain.calls[0].images[0]
    expect(forwarded.mediaType).toBe('image/png')
    const decoded = PNG.sync.read(Buffer.from(forwarded.image, 'base64'))
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(VISION_MAX_EDGE_PX)
    // Aspect ratio held: the long edge hits the cap, the short edge scales with it.
    expect(decoded.height).toBe(VISION_MAX_EDGE_PX)
  })
})
