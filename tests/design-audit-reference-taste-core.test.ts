import { describe, it, expect } from 'vitest'
import {
  tasteAgreement,
  tasteMetricsFromVerdicts,
  positionBiasRate,
  calibrateAgainstVotes,
  type SwappedRun,
} from '../src/design/audit/reference/eval/taste-core.js'
import type {
  RawVerdict,
  TastePair,
  TasteVerdict,
} from '../src/design/audit/reference/contracts.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

const tv = (aId: string, bId: string, winner: string | 'tie', margin = 0.6): TasteVerdict => ({
  aId,
  bId,
  winner,
  margin,
  reasons: [],
})

const raw = (winnerSlot: RawVerdict['winnerSlot'], confidence = 0.8): RawVerdict => ({
  winnerSlot,
  confidence,
  reasons: [],
})

const pair = (strongId: string, weakId: string): TastePair => ({ strongId, weakId })

// ── judge-vs-label agreement (corpus-vs-corpus) ──────────────────────────────

describe('tasteAgreement', () => {
  const pairs: TastePair[] = [pair('stripe', 'weak1'), pair('linear', 'weak2'), pair('vercel', 'weak3')]

  it('agrees when the judge prefers the labelled-stronger member', () => {
    const verdicts: TasteVerdict[] = [
      tv('stripe', 'weak1', 'stripe'),
      tv('linear', 'weak2', 'linear'),
      tv('vercel', 'weak3', 'vercel'),
    ]
    expect(tasteAgreement(pairs, verdicts)).toEqual({ agreementRate: 1, n: 3 })
  })

  it('counts a wrong order as a disagreement regardless of slot orientation', () => {
    // The judged verdict can be recorded in either slot order; lookup is unordered.
    const verdicts: TasteVerdict[] = [
      tv('weak1', 'stripe', 'stripe'), // strong wins despite being slot b → agree
      tv('weak2', 'linear', 'weak2'), // weak wins → disagree
      tv('vercel', 'weak3', 'vercel'), // agree
    ]
    const r = tasteAgreement(pairs, verdicts)
    expect(r.n).toBe(3)
    expect(r.agreementRate).toBeCloseTo(2 / 3, 4)
  })

  it('excludes judge ties and pairs the judge never compared from n', () => {
    const verdicts: TasteVerdict[] = [
      tv('stripe', 'weak1', 'stripe'), // agree
      tv('linear', 'weak2', 'tie'), // tie → excluded
      // vercel/weak3 never judged → excluded
    ]
    expect(tasteAgreement(pairs, verdicts)).toEqual({ agreementRate: 1, n: 1 })
  })

  it('returns 0 / 0 (never NaN) on empty input', () => {
    expect(tasteAgreement([], [])).toEqual({ agreementRate: 0, n: 0 })
    expect(tasteAgreement(pairs, [])).toEqual({ agreementRate: 0, n: 0 })
  })
})

// ── generated-vs-reference metrics ───────────────────────────────────────────

describe('tasteMetricsFromVerdicts', () => {
  it('counts decisive wins of generated directions over the reference', () => {
    const verdicts: TasteVerdict[] = [
      tv('genA', 'ref', 'genA'), // win (ref in slot b)
      tv('ref', 'genB', 'genB'), // win (ref in slot a)
      tv('ref', 'genC', 'ref'), // loss
      tv('genD', 'ref', 'tie'), // tie → excluded
      tv('genE', 'genF', 'genE'), // no reference → excluded
    ]
    expect(tasteMetricsFromVerdicts('ref', verdicts)).toEqual({
      winsVsReference: 2,
      comparisons: 3,
    })
  })

  it('leaves corpusOrderAgreement undefined (a different verdict set)', () => {
    const m = tasteMetricsFromVerdicts('ref', [tv('genA', 'ref', 'genA')])
    expect(m.corpusOrderAgreement).toBeUndefined()
  })

  it('ignores self-pairs and returns 0 / 0 on empty input', () => {
    expect(tasteMetricsFromVerdicts('ref', [tv('ref', 'ref', 'ref')])).toEqual({
      winsVsReference: 0,
      comparisons: 0,
    })
    expect(tasteMetricsFromVerdicts('ref', [])).toEqual({ winsVsReference: 0, comparisons: 0 })
  })
})

// ── position-bias rate (from swapped runs) ───────────────────────────────────

describe('positionBiasRate', () => {
  it('flags pure slot bias: a judge that always picks slot A flips the id every run', () => {
    // ab: a→A wins (id=a). ba: b→A wins (id=b). The id flipped ⇒ position bias.
    const runs: SwappedRun[] = [
      { aId: 'a', bId: 'b', ab: raw('A'), ba: raw('A') },
      { aId: 'c', bId: 'd', ab: raw('A'), ba: raw('A') },
    ]
    expect(positionBiasRate(runs)).toEqual({ biasRate: 1, n: 2 })
  })

  it('reports zero bias when the same id wins in both orders (genuine taste)', () => {
    // ab: a→A wins (id=a). ba: a→B wins (id=a). The id is stable ⇒ no slot bias.
    const runs: SwappedRun[] = [{ aId: 'a', bId: 'b', ab: raw('A'), ba: raw('B') }]
    expect(positionBiasRate(runs)).toEqual({ biasRate: 0, n: 1 })
  })

  it('excludes runs where either order tied from the denominator', () => {
    const runs: SwappedRun[] = [
      { aId: 'a', bId: 'b', ab: raw('tie'), ba: raw('A') }, // not decisive → skipped
      { aId: 'c', bId: 'd', ab: raw('A'), ba: raw('A') }, // biased, decisive
      { aId: 'e', bId: 'f', ab: raw('A'), ba: raw('B') }, // unbiased, decisive
    ]
    expect(positionBiasRate(runs)).toEqual({ biasRate: 0.5, n: 2 })
  })

  it('returns 0 / 0 (never NaN) on empty input', () => {
    expect(positionBiasRate([])).toEqual({ biasRate: 0, n: 0 })
  })
})

// ── calibration hook (re-exported HumanVote agreement) ───────────────────────

describe('calibrateAgainstVotes (re-exported calibration hook)', () => {
  it('is re-exported from taste-core and scores judge-vs-human agreement', () => {
    const verdicts: TasteVerdict[] = [tv('A', 'B', 'A'), tv('B', 'C', 'B'), tv('A', 'C', 'C')]
    const result = calibrateAgainstVotes(verdicts, [
      { aId: 'A', bId: 'B', winner: 'A' }, // agree
      { aId: 'B', bId: 'C', winner: 'B' }, // agree
      { aId: 'A', bId: 'C', winner: 'A' }, // disagree (judge said C)
      { aId: 'A', bId: 'B', winner: 'tie' }, // human tie → excluded
    ])
    expect(result.n).toBe(3)
    expect(result.agreement).toBeCloseTo(2 / 3, 4)
  })
})
