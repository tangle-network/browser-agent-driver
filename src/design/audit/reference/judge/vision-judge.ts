/**
 * Vision taste judge — a screenshot-grounded `TasteJudge` that is a drop-in for
 * the default text judge. PURE given its injected models: it imports no Brain and
 * does no IO, so it unit-tests with deterministic `VisionJudgeModel` stubs and no
 * live model. The disk read + provider round-trip live behind the injected seam
 * (`judge/vision-model.createBrainVisionModel`).
 *
 * What it adds over the text judge: it judges from the subjects' SCREENSHOTS (the
 * audited page and the corpus exemplars), not just their DNA text — so the
 * absolute-quality leg (`judge/quality.assessPageQuality`) becomes a genuine
 * visual page-vs-exemplar comparison. It reuses the text judge's pure prompt
 * cores (`buildQualityPrompt`/`buildPairwisePrompt`) and parser
 * (`parseVerdictOrNull`) verbatim — vision adds images, not new prompt logic.
 *
 * TWO layered debiases, kept separate so neither is double-applied:
 *  - POSITION-SWAP (A-vs-B and B-vs-A) is NOT done here. The surrounding pure
 *    debias core (`judge/pairwise.judgePair`) already calls `compare` twice and
 *    reconciles, so one `compare` is ONE slot order. Re-swapping internally would
 *    double the model calls and break that core's accounting.
 *  - The ENSEMBLE (across MODELS) IS done here: every model runs in parallel on
 *    the given slot order, then aggregates to a majority winner with an honest
 *    agreement-fraction confidence (see `aggregateVerdicts`). With one model it
 *    degrades to a single judge; with many it is robust to single-model bias.
 *
 * Fail-closed: a model that throws or returns no parseable winner is DROPPED; if
 * every model is dropped, `compare` throws rather than fabricating a tie. An empty
 * model list is rejected at construction.
 *
 * SCOPE: only subjects that HAVE a screenshot are vision-judged. Unrendered
 * `RedesignDirection` specs carry none, so a comparison with a screenshot-less
 * side delegates to the injected text fallback — keeping this a single drop-in
 * judge for BOTH the quality leg (vision) and the direction-ranking leg (text).
 */

import type {
  JudgePairInput,
  RawVerdict,
  TasteJudge,
  VisionImageRef,
  VisionJudgeModel,
} from '../contracts.js'
import { buildPairwisePrompt, buildQualityPrompt } from './prompt.js'
import { parseVerdictOrNull } from './parse.js'

// Verdict JSON is tiny; cap output so a runaway response can't blow budget. Same
// ceiling as the text judge (`text-judge.JUDGE_MAX_OUTPUT_TOKENS`).
const JUDGE_MAX_OUTPUT_TOKENS = 400

// Merged-reason ceiling on the aggregated verdict, so an N-model ensemble cannot
// bloat one `RawVerdict` with N× the reasons.
const REASON_CAP = 8

// Prepended to the reused text prompt so the model maps images→slots. The images
// are attached in slot order ([slot A, slot B]); `compare` always renders the
// input on slot order 'AB', and the outer `judgePair` supplies the swapped order.
const VISION_PREAMBLE =
  'Two screenshots are attached. The FIRST image is SLOT A; the SECOND image is SLOT B. ' +
  'Judge primarily from the screenshots — the text below is a secondary DNA summary of each design.'

const round4 = (n: number): number => Math.round(n * 10000) / 10000

/**
 * Collapse the surviving per-model verdicts into one ensemble `RawVerdict` body
 * (winnerSlot + honest confidence + merged reasons). PURE. Throws on an empty set
 * — an all-dropped ensemble is an explicit error, never a fabricated tie.
 *
 * The bucket (A/B/tie) with the STRICT maximum vote count wins; a genuine `tie`
 * vote counts in its own bucket. `confidence` is that bucket's vote share
 * (agreement fraction). A split — two or more buckets sharing the top count —
 * is undecided ⇒ tie at confidence 0.
 */
export function aggregateVerdicts(verdicts: RawVerdict[]): {
  winnerSlot: RawVerdict['winnerSlot']
  confidence: number
  reasons: string[]
} {
  if (verdicts.length === 0) {
    throw new Error('vision judge: cannot aggregate an empty set of verdicts')
  }
  const counts: Record<RawVerdict['winnerSlot'], number> = { A: 0, B: 0, tie: 0 }
  for (const v of verdicts) counts[v.winnerSlot]++

  const total = verdicts.length
  const top = Math.max(counts.A, counts.B, counts.tie)
  const leaders = (['A', 'B', 'tie'] as const).filter((slot) => counts[slot] === top)
  const decided = leaders.length === 1
  const winnerSlot: RawVerdict['winnerSlot'] = decided ? leaders[0] : 'tie'
  const confidence = decided ? round4(top / total) : 0

  const reasons: string[] = [
    `ensemble: A=${counts.A} B=${counts.B} tie=${counts.tie} over ${total} model${total === 1 ? '' : 's'}`,
  ]
  for (const v of verdicts) {
    for (const r of v.reasons) if (!reasons.includes(r)) reasons.push(r)
  }
  return { winnerSlot, confidence, reasons: reasons.slice(0, REASON_CAP) }
}

interface ModelOutcome {
  verdict: RawVerdict | null
  tokens: number
}

/** Run one model on a single slot order; a throw/unparseable result is a drop. */
async function runModel(
  model: VisionJudgeModel,
  system: string,
  user: string,
  images: VisionImageRef[],
): Promise<ModelOutcome> {
  try {
    const { text, tokensUsed } = await model.completeVision(system, user, images, {
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    })
    const verdict = parseVerdictOrNull(text)
    if (!verdict && process.env.BAD_VISION_JUDGE_DEBUG === '1')
      console.error(`[vision ${model.id}] parse-failed | len=${text.length} head=${JSON.stringify(text.slice(0, 240))}`)
    return { verdict, tokens: tokensUsed ?? 0 }
  } catch (err) {
    if (process.env.BAD_VISION_JUDGE_DEBUG === '1')
      console.error(`[vision ${model.id}] call-failed: ${err instanceof Error ? err.message : String(err)}`)
    return { verdict: null, tokens: 0 }
  }
}

/**
 * Build a vision `TasteJudge` over a non-empty list of `VisionJudgeModel`s. One
 * model ⇒ a single judge; many ⇒ the cross-model ensemble. `textFallback` (the
 * default text judge, injected by the wiring) handles comparisons whose subjects
 * lack screenshots; omit it only in tests that never exercise that path.
 */
export function createVisionJudge(
  models: VisionJudgeModel[],
  opts: { textFallback?: TasteJudge } = {},
): TasteJudge {
  if (models.length === 0) {
    throw new Error('vision judge: at least one vision model is required (empty ensemble)')
  }
  const { textFallback } = opts
  const id = `vision-judge[${models.map((m) => m.id).join('+')}]`

  return {
    id,
    async compare(input: JudgePairInput): Promise<RawVerdict> {
      const { a, b } = input
      // Vision needs an image on BOTH sides. Screenshot-less subjects (unrendered
      // directions) delegate to the injected text judge, so one instance serves
      // the vision quality leg AND the text direction leg.
      if (!a.screenshotPath || !b.screenshotPath) {
        if (!textFallback) {
          throw new Error(
            `vision judge: subjects ${a.id}/${b.id} lack screenshots and no text fallback was injected`,
          )
        }
        return textFallback.compare(input)
      }

      // Mirror the text judge's prompt selection; both subjects carry screenshots
      // here, so this is the absolute-quality leg in practice.
      const usesDirections = Boolean(a.directionSummary || b.directionSummary)
      const { system, user } = usesDirections
        ? buildPairwisePrompt(input, 'AB')
        : buildQualityPrompt(input, 'AB')
      const userWithImages = `${VISION_PREAMBLE}\n\n${user}`
      const images: VisionImageRef[] = [
        { screenshotPath: a.screenshotPath },
        { screenshotPath: b.screenshotPath },
      ]

      const outcomes = await Promise.all(models.map((m) => runModel(m, system, userWithImages, images)))
      const survivors = outcomes
        .map((o) => o.verdict)
        .filter((v): v is RawVerdict => v !== null)
      const tokensUsed = outcomes.reduce((sum, o) => sum + o.tokens, 0)

      if (survivors.length === 0) {
        throw new Error(
          `vision judge: every model in the ensemble (${models.length}) failed to return a usable ` +
            'verdict; refusing to fabricate a tie',
        )
      }

      const agg = aggregateVerdicts(survivors)
      const verdict: RawVerdict = { winnerSlot: agg.winnerSlot, confidence: agg.confidence, reasons: agg.reasons }
      const withTokens = tokensUsed > 0 ? { ...verdict, tokensUsed } : verdict
      return input.dimension !== undefined ? { ...withTokens, dimension: input.dimension } : withTokens
    },
  }
}
