/**
 * Position-swapped pairwise debias — the core that cancels slot bias.
 *
 * A single judge call is contaminated by position bias: models systematically
 * over-prefer whichever design sits in slot A. `judgePair` neutralises it by
 * running BOTH slot orders through the INJECTED `TasteJudge` (A-vs-B and
 * B-vs-A) and reconciling. The model call is the only impure part and it is
 * injected, so `reconcileVerdicts` — where all the debias logic lives — is fully
 * pure and unit-tests with stub verdicts and zero live model.
 *
 * Reconciliation rule (measures taste, not slot):
 *  - both orders pick the SAME id  ⇒ that id wins (margin = mean confidence)
 *  - the preferred id FLIPS with the slot ⇒ pure position bias ⇒ tie
 *  - only one order separates them ⇒ a low-confidence win (margin halved)
 *  - both orders tie ⇒ tie
 *
 * `swapped` re-labels the subjects (a↔b) while preserving `dimension`,
 * `reference`, and `rubricBody`, so the judge sees the same comparison from the
 * other side — the second call is a genuine slot swap, not a different question.
 */

import type { JudgePairInput, RawVerdict, TasteJudge, TasteVerdict } from '../contracts.js'

const round4 = (n: number): number => Math.round(n * 10000) / 10000
const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

function slotToId(slot: RawVerdict['winnerSlot'], idForSlotA: string, idForSlotB: string): string | 'tie' {
  if (slot === 'A') return idForSlotA
  if (slot === 'B') return idForSlotB
  return 'tie'
}

function mergeReasons(...lists: string[][]): string[] {
  const out: string[] = []
  for (const list of lists) {
    for (const r of list) if (!out.includes(r)) out.push(r)
  }
  return out
}

/**
 * Reconcile the two slot-order verdicts into a stable, id-keyed `TasteVerdict`.
 * Pure: no IO, no model. `ab` presented a→SLOT A, b→SLOT B; `ba` presented
 * b→SLOT A, a→SLOT B.
 */
export function reconcileVerdicts(
  ab: RawVerdict,
  ba: RawVerdict,
  aId: string,
  bId: string,
): TasteVerdict {
  const w1 = slotToId(ab.winnerSlot, aId, bId)
  const w2 = slotToId(ba.winnerSlot, bId, aId)
  const reasons = mergeReasons(ab.reasons, ba.reasons)

  if (w1 === 'tie' && w2 === 'tie') {
    return { aId, bId, winner: 'tie', margin: 0, reasons }
  }

  if (w1 !== 'tie' && w2 !== 'tie') {
    if (w1 === w2) {
      const margin = clamp01(round4((ab.confidence + ba.confidence) / 2))
      return { aId, bId, winner: w1, margin, reasons }
    }
    // The preferred id flipped with the slot ⇒ the signal is position, not taste.
    return {
      aId,
      bId,
      winner: 'tie',
      margin: 0,
      reasons: mergeReasons(reasons, [
        'position bias: preferred slot flipped across orders; collapsed to tie',
      ]),
    }
  }

  // Exactly one order expressed a preference; the other could not separate them.
  // Honour the uncontradicted signal but at halved confidence.
  const decided = w1 !== 'tie' ? w1 : w2
  const conf = w1 !== 'tie' ? ab.confidence : ba.confidence
  return { aId, bId, winner: decided, margin: clamp01(round4(conf / 2)), reasons }
}

/**
 * Run a single comparison through both slot orders (× `reps`) and reconcile to a
 * position-debiased `TasteVerdict`. The `TasteJudge` is injected, so this is the
 * only impure boundary; all aggregation is deterministic.
 */
export async function judgePair(
  judge: TasteJudge,
  input: JudgePairInput,
  reps = 1,
): Promise<TasteVerdict> {
  const aId = input.a.id
  const bId = input.b.id
  const swapped: JudgePairInput = { ...input, a: input.b, b: input.a }
  const effReps = Math.max(1, Math.floor(reps))

  let scoreA = 0
  let scoreB = 0
  const reasons: string[] = []
  for (let i = 0; i < effReps; i++) {
    const ab = await judge.compare(input)
    const ba = await judge.compare(swapped)
    const v = reconcileVerdicts(ab, ba, aId, bId)
    if (v.winner === aId) scoreA += v.margin
    else if (v.winner === bId) scoreB += v.margin
    for (const r of v.reasons) if (!reasons.includes(r)) reasons.push(r)
  }

  const net = (scoreA - scoreB) / effReps
  if (net > 1e-9) return { aId, bId, winner: aId, margin: clamp01(round4(net)), reasons }
  if (net < -1e-9) return { aId, bId, winner: bId, margin: clamp01(round4(-net)), reasons }
  return { aId, bId, winner: 'tie', margin: 0, reasons }
}
