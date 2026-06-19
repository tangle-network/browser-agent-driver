/**
 * Brain-backed vision-model adapter — the IO half of the vision judge stack.
 *
 * The vision ensemble depends only on the narrow `VisionJudgeModel` seam
 * (contracts): a model bound to ONE `{ provider, model }` ref that takes a system
 * prompt + a user prompt + the compared subjects' screenshots and returns raw
 * text. This module is the concrete, Brain-backed implementation of that seam.
 * It is the ONLY impure part of the vision judge (disk read + a live model call);
 * the aggregation in `vision-judge.ts` stays pure and unit-tests with stubs.
 *
 * Two responsibilities, both thin:
 *  - `createBrainVisionModel`: wrap one Brain as a `VisionJudgeModel` — resolve
 *    each `VisionImageRef` to encoded bytes (disk read for `screenshotPath`,
 *    mediaType from the file extension; passthrough for in-memory base64) and
 *    route them through `brain.completeVision`. The `id` is the ref rendered as
 *    `provider:model`, so an ensemble keys/aggregates per model.
 *  - `buildVisionModels`: construct the ensemble from a `ModelRef[]` — ONE Brain
 *    per ref, each with its OWN provider key. A single Brain CANNOT serve a mixed
 *    ensemble: `Brain.getModel` resolves the key via
 *    `resolveProviderApiKey(provider, this.explicitApiKey)`, so an explicit key
 *    set for one provider would leak to the others. Per-ref Brains give each ref
 *    the correct provider key (resolved from the environment).
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Brain } from '../../../../brain/index.js'
import { clampPngLongestEdge } from './image-clamp.js'
import {
  resolveDefaultProvider,
  resolveProviderApiKey,
  resolveProviderModelName,
  type SupportedProvider,
} from '../../../../provider-defaults.js'
import type { ModelRef, VisionImageRef, VisionJudgeModel } from '../contracts.js'

/** The encoded image shape `Brain.completeVision` accepts (base64/data + type). */
interface EncodedImage {
  image: string
  mediaType: string
}

/**
 * The narrow Brain capability this adapter needs — exactly `Brain.completeVision`.
 * Declared locally so the wrapper does not depend on the full `Brain` type and a
 * test could inject a fake round-trip; `buildVisionModels` supplies the real one.
 */
export interface VisionCompletionModel {
  completeVision(
    system: string,
    user: string,
    images: ReadonlyArray<EncodedImage>,
    options?: { maxOutputTokens?: number },
  ): Promise<{ text: string; tokensUsed?: number }>
}

/** Render a `ModelRef` as the stable `provider:model` id the ensemble keys on. */
export function refToId(ref: ModelRef): string {
  return `${ref.provider ?? resolveDefaultProvider()}:${ref.model}`
}

/** Infer an image mediaType from a screenshot file extension (PNG default). */
function mediaTypeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

/**
 * Resolve a `VisionImageRef` to encoded bytes (disk read for on-disk paths).
 * Full-page PNG captures are clamped to the vision API's longest-edge limit first
 * (see {@link clampPngLongestEdge}) — without it, a tall exemplar screenshot trips
 * Anthropic's 8000px hard limit and the whole comparison fails. The clamp is a
 * no-op for in-bounds images and for non-PNG bytes, so it never alters a small
 * screenshot.
 */
async function resolveImage(ref: VisionImageRef): Promise<EncodedImage> {
  if ('base64' in ref) {
    if (ref.mediaType !== 'image/png') return { image: ref.base64, mediaType: ref.mediaType }
    const clamped = clampPngLongestEdge(Buffer.from(ref.base64, 'base64'))
    return { image: clamped.toString('base64'), mediaType: ref.mediaType }
  }
  const mediaType = mediaTypeForPath(ref.screenshotPath)
  const buf = await readFile(ref.screenshotPath)
  const bytes = mediaType === 'image/png' ? clampPngLongestEdge(buf) : buf
  return { image: bytes.toString('base64'), mediaType }
}

/**
 * Wrap one Brain (already bound to a `{ provider, model }`) as a
 * `VisionJudgeModel`. The disk read + mediaType inference happen here so the
 * pure ensemble never touches the filesystem; a failed read or model call
 * propagates as a rejection, which the ensemble treats as a DROPPED model.
 */
export function createBrainVisionModel(brain: VisionCompletionModel, ref: ModelRef): VisionJudgeModel {
  return {
    id: refToId(ref),
    async completeVision(system, user, images, options) {
      const encoded = await Promise.all(images.map(resolveImage))
      return brain.completeVision(system, user, encoded, options)
    },
  }
}

/**
 * Construct the vision ensemble: ONE Brain per `ModelRef`, each resolving its own
 * provider/model/api-key through `provider-defaults` (so a mixed
 * openai+anthropic+google ensemble each gets the right env key). `vision: true`
 * is set for clarity; `completeVision` builds its own multimodal message and does
 * not depend on the Brain's vision strategy.
 *
 * Future lever: explicit per-vision-model `--api-key`/`--base-url` (today each ref
 * resolves its key from the environment by provider; the audit's own brain still
 * honours an explicit `--api-key`).
 */
export function buildVisionModels(refs: ModelRef[]): VisionJudgeModel[] {
  return refs.map((ref) => {
    const provider: SupportedProvider = ref.provider ?? resolveDefaultProvider()
    const model = resolveProviderModelName(provider, ref.model)
    const brain = new Brain({
      provider,
      model,
      apiKey: resolveProviderApiKey(provider),
      vision: true,
      // The Claude Code SDK drops image parts unless streaming input is on; these
      // Brains exist only to send screenshots, so force it. No-op for every other
      // provider, so a mixed ensemble is unaffected.
      claudeCodeStreamingInput: true,
      // Opt-in per-call provider logging for diagnosing dropped vision verdicts.
      debug: process.env.BAD_VISION_JUDGE_DEBUG === '1',
      llmTimeoutMs: 120_000,
    })
    return createBrainVisionModel(brain, { provider, model })
  })
}
