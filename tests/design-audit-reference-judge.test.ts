import { describe, it, expect } from 'vitest'
import { buildPairwisePrompt, buildQualityPrompt } from '../src/design/audit/reference/judge/prompt.js'
import { parseRawVerdict } from '../src/design/audit/reference/judge/parse.js'
import { reconcileVerdicts, judgePair } from '../src/design/audit/reference/judge/pairwise.js'
import { assessPageQuality } from '../src/design/audit/reference/judge/quality.js'
import {
  rankDirections,
  bradleyTerry,
  updateElo,
  calibrateAgainstVotes,
} from '../src/design/audit/reference/judge/rank.js'
import { createTextJudge } from '../src/design/audit/reference/judge/text-judge.js'
import type {
  JudgePairInput,
  JudgeSubject,
  RawVerdict,
  TasteJudge,
  TasteVerdict,
  Dimension,
  DesignDNA,
} from '../src/design/audit/reference/contracts.js'

// ── fixtures ─────────────────────────────────────────────────────────────────

const subject = (id: string, over: Partial<JudgeSubject> = {}): JudgeSubject => ({
  id,
  dnaSummary: `dna of ${id}`,
  ...over,
})

const verdict = (
  winnerSlot: RawVerdict['winnerSlot'],
  confidence = 0.8,
  reasons: string[] = [],
): RawVerdict => ({ winnerSlot, confidence, reasons })

const tv = (aId: string, bId: string, winner: string | 'tie', margin = 0.5): TasteVerdict => ({
  aId,
  bId,
  winner,
  margin,
  reasons: [],
})

/**
 * A judge that picks `favouredId` no matter which slot it sits in — i.e. genuine
 * taste, invariant to position. Reconciliation must surface it as the winner.
 */
function tasteJudge(favouredId: string, confidence = 0.9): TasteJudge {
  return {
    id: 'taste-stub',
    async compare(input: JudgePairInput): Promise<RawVerdict> {
      if (input.a.id === favouredId) return verdict('A', confidence, ['favoured'])
      if (input.b.id === favouredId) return verdict('B', confidence, ['favoured'])
      return verdict('tie', 0.1, ['neither favoured'])
    },
  }
}

/** A judge that always picks SLOT A — pure position bias, zero taste signal. */
const slotAJudge: TasteJudge = {
  id: 'slot-a-stub',
  async compare(): Promise<RawVerdict> {
    return verdict('A', 0.9, ['always slot A'])
  },
}

/** A judge that always ties. */
const tieJudge: TasteJudge = {
  id: 'tie-stub',
  async compare(): Promise<RawVerdict> {
    return verdict('tie', 0.5, ['indistinguishable'])
  },
}

// ── prompt ───────────────────────────────────────────────────────────────────

describe('judge prompts', () => {
  const input: JudgePairInput = {
    a: subject('dir-a', { directionSummary: 'Editorial Calm' }),
    b: subject('dir-b', { directionSummary: 'Dense Control Room' }),
    reference: { kind: 'url', dna: {} as unknown as DesignDNA, summary: 'REF-SUMMARY' },
  }

  it('is byte-stable for fixed inputs and carries the anti-position-bias clause', () => {
    const p1 = buildPairwisePrompt(input, 'AB')
    const p2 = buildPairwisePrompt(input, 'AB')
    expect(p1).toEqual(p2)
    expect(p1.system).toContain('randomized order that carries NO information')
    expect(p1.system).toContain('art director')
  })

  it('injects the reference only when present', () => {
    const withRef = buildPairwisePrompt(input, 'AB')
    expect(withRef.user).toContain('REFERENCE (url)')
    expect(withRef.user).toContain('REF-SUMMARY')

    const noRef = buildPairwisePrompt({ a: input.a, b: input.b }, 'AB')
    expect(noRef.user).not.toContain('REFERENCE')
  })

  it('swaps the physical slot order between AB and BA without changing the system prompt', () => {
    const ab = buildPairwisePrompt(input, 'AB')
    const ba = buildPairwisePrompt(input, 'BA')
    expect(ab.system).toBe(ba.system)
    // In AB, direction-a renders first; in BA, direction-b renders first.
    expect(ab.user.indexOf('Editorial Calm')).toBeLessThan(ab.user.indexOf('Dense Control Room'))
    expect(ba.user.indexOf('Dense Control Room')).toBeLessThan(ba.user.indexOf('Editorial Calm'))
  })

  it('narrows the quality prompt to a single dimension when scoped', () => {
    const scoped = buildQualityPrompt(
      { a: subject('page'), b: subject('exemplar'), dimension: 'visual_craft' },
      'AB',
    )
    expect(scoped.system).toContain('design critic')
    expect(scoped.system).toContain('visual_craft')
    expect(scoped.user).toContain('world-class "visual_craft"')

    const holistic = buildQualityPrompt({ a: subject('page'), b: subject('exemplar') }, 'AB')
    expect(holistic.system).not.toContain('visual_craft')
    expect(holistic.user).toContain('higher-quality design overall')
  })
})

// ── parse ────────────────────────────────────────────────────────────────────

describe('parseRawVerdict', () => {
  it('parses a well-formed verdict', () => {
    expect(parseRawVerdict('{"winner":"A","confidence":0.8,"reasons":["clean type"]}')).toEqual({
      winnerSlot: 'A',
      confidence: 0.8,
      reasons: ['clean type'],
    })
  })

  it('tolerates markdown fences and prose preambles', () => {
    expect(parseRawVerdict('```json\n{"winner":"B","confidence":0.6,"reasons":[]}\n```').winnerSlot).toBe('B')
    expect(
      parseRawVerdict('Here is the verdict: {"winner":"tie","confidence":0.5,"reasons":["on par"]} — done')
        .winnerSlot,
    ).toBe('tie')
  })

  it('clamps confidence into [0,1]', () => {
    expect(parseRawVerdict('{"winner":"A","confidence":5}').confidence).toBe(1)
    expect(parseRawVerdict('{"winner":"A","confidence":-3}').confidence).toBe(0)
  })

  it('fails closed to a tie on garbage or a missing winner', () => {
    const garbage = parseRawVerdict('the model rambled and produced no json')
    expect(garbage.winnerSlot).toBe('tie')
    expect(garbage.confidence).toBe(0)
    expect(garbage.reasons[0]).toMatch(/unparseable/)

    const noWinner = parseRawVerdict('{"confidence":0.7,"reasons":["x"]}')
    expect(noWinner.winnerSlot).toBe('tie')
    expect(noWinner.reasons[0]).toMatch(/missing a valid winner/)
  })
})

// ── pairwise debias (the position-bias canceller) ────────────────────────────

describe('reconcileVerdicts (pure debias)', () => {
  it('surfaces the winner when both slot orders agree on the same id', () => {
    // AB: slot A (=a) wins; BA: slot B (=a) wins ⇒ judge prefers `a` either way.
    const r = reconcileVerdicts(verdict('A', 0.8), verdict('B', 0.9), 'a', 'b')
    expect(r.winner).toBe('a')
    expect(r.margin).toBe(0.85)
  })

  it('collapses to a tie when the preferred slot flips (pure position bias)', () => {
    // Both orders pick SLOT A ⇒ a then b ⇒ contradiction ⇒ position bias ⇒ tie.
    const r = reconcileVerdicts(verdict('A', 0.9), verdict('A', 0.9), 'a', 'b')
    expect(r.winner).toBe('tie')
    expect(r.margin).toBe(0)
    expect(r.reasons.some((x) => x.includes('position bias'))).toBe(true)
  })

  it('returns a low-confidence win when only one order separates them', () => {
    // AB ties; BA slot B (=a) wins ⇒ uncontradicted weak preference for `a`.
    const r = reconcileVerdicts(verdict('tie', 0.5), verdict('B', 0.8), 'a', 'b')
    expect(r.winner).toBe('a')
    expect(r.margin).toBe(0.4)
  })

  it('returns a tie when both orders tie', () => {
    const r = reconcileVerdicts(verdict('tie'), verdict('tie'), 'a', 'b')
    expect(r.winner).toBe('tie')
    expect(r.margin).toBe(0)
  })
})

describe('judgePair (injected judge × double-run)', () => {
  it('issues both slot orders and resolves a consistent taste preference', async () => {
    let calls = 0
    const counting: TasteJudge = {
      id: 'count',
      async compare(input) {
        calls++
        return input.a.id === 'x' ? verdict('A', 0.9) : input.b.id === 'x' ? verdict('B', 0.9) : verdict('tie')
      },
    }
    const r = await judgePair(counting, { a: subject('x'), b: subject('y') })
    expect(calls).toBe(2) // exactly one AB + one BA call
    expect(r.winner).toBe('x')
    expect(r.margin).toBeCloseTo(0.9, 5)
  })

  it('neutralises a slot-A-biased judge to a tie', async () => {
    const r = await judgePair(slotAJudge, { a: subject('x'), b: subject('y') })
    expect(r.winner).toBe('tie')
    expect(r.margin).toBe(0)
  })

  it('runs reps × 2 calls and stays consistent across reps', async () => {
    let calls = 0
    const counting: TasteJudge = {
      id: 'count',
      async compare(input) {
        calls++
        return input.a.id === 'x' ? verdict('A', 0.8) : verdict('B', 0.8)
      },
    }
    const r = await judgePair(counting, { a: subject('x'), b: subject('y') }, 3)
    expect(calls).toBe(6)
    expect(r.winner).toBe('x')
  })
})

// ── absolute quality leg ─────────────────────────────────────────────────────

describe('assessPageQuality', () => {
  const page = subject('page')
  const exemplars = [subject('ex1'), subject('ex2')]

  it('computes an overall win-rate and leaves dimensionWinRates undefined by default', async () => {
    const q = await assessPageQuality(tasteJudge('page'), page, exemplars)
    expect(q.overallWinRate).toBe(1)
    expect(q.comparisons).toBe(2)
    expect(q.dimensionWinRates).toBeUndefined()
  })

  it('excludes ties from the comparison count and reports an on-par win-rate', async () => {
    const q = await assessPageQuality(tieJudge, page, exemplars)
    expect(q.comparisons).toBe(0)
    expect(q.overallWinRate).toBe(0.5)
  })

  it('resolves per-dimension win-rates independently (not one number stamped across dims)', async () => {
    // Stub favours the page ONLY on visual_craft; on every other dimension the
    // exemplar wins. Proves each dimension is genuinely judge-resolved.
    const favoured: Dimension = 'visual_craft'
    const perDimJudge: TasteJudge = {
      id: 'per-dim',
      async compare(input) {
        const exId = input.a.id === 'page' ? input.b.id : input.a.id
        const winnerId =
          input.dimension === undefined || input.dimension === favoured ? 'page' : exId
        return input.a.id === winnerId ? verdict('A', 0.9) : verdict('B', 0.9)
      },
    }
    const dims: Dimension[] = ['product_intent', 'visual_craft', 'trust_clarity', 'workflow', 'content_ia']
    const q = await assessPageQuality(perDimJudge, page, exemplars, { dimensions: dims })

    expect(q.overallWinRate).toBe(1)
    expect(q.dimensionWinRates?.visual_craft).toBe(1)
    expect(q.dimensionWinRates?.product_intent).toBe(0)
    expect(q.dimensionWinRates?.workflow).toBe(0)
    // Every requested dimension was resolved.
    expect(Object.keys(q.dimensionWinRates ?? {}).sort()).toEqual([...dims].sort())
  })
})

// ── Bradley-Terry / Elo ranking ──────────────────────────────────────────────

describe('rank (Bradley-Terry / Elo)', () => {
  it('orders a transitive tournament A > B > C', () => {
    const verdicts: TasteVerdict[] = [
      tv('A', 'B', 'A', 0.8),
      tv('B', 'C', 'B', 0.7),
      tv('A', 'C', 'A', 0.9),
    ]
    const result = rankDirections(['A', 'B', 'C'], verdicts)
    expect(result.order).toEqual(['A', 'B', 'C'])
    expect(result.winnerId).toBe('A')
    expect(result.bradleyTerry.A).toBeGreaterThan(result.bradleyTerry.B)
    expect(result.bradleyTerry.B).toBeGreaterThan(result.bradleyTerry.C)
    expect(result.elo.A).toBeGreaterThan(result.elo.C)
  })

  it('sum-normalises Bradley-Terry strengths', () => {
    const verdicts: TasteVerdict[] = [tv('A', 'B', 'A'), tv('B', 'C', 'B'), tv('A', 'C', 'A')]
    const bt = bradleyTerry(verdicts)
    const sum = Object.values(bt).reduce((s, n) => s + n, 0)
    expect(sum).toBeCloseTo(1, 4)
  })

  it('falls back to a uniform distribution when ids exist but no games were played', () => {
    const result = rankDirections(['A', 'B'], [])
    expect(result.bradleyTerry.A).toBeCloseTo(0.5, 6)
    expect(result.bradleyTerry.B).toBeCloseTo(0.5, 6)
  })

  it('updateElo is symmetric and conserves total rating', () => {
    const [ra, rb] = updateElo(1500, 1500, 1)
    expect(ra).toBeCloseTo(1516, 6)
    expect(rb).toBeCloseTo(1484, 6)
    expect(ra + rb).toBeCloseTo(3000, 6)

    const [rb2, ra2] = updateElo(1500, 1500, 0)
    expect(ra2).toBeCloseTo(1516, 6) // swapping players + complementing outcome mirrors
    expect(rb2).toBeCloseTo(1484, 6)
  })

  it('ranks a seeded-but-unjudged direction last', () => {
    const verdicts: TasteVerdict[] = [tv('A', 'B', 'A')]
    const result = rankDirections(['A', 'B', 'lonely'], verdicts)
    expect(result.order[result.order.length - 1]).toBe('lonely')
    expect(result.bradleyTerry.lonely).toBe(0)
  })
})

describe('calibrateAgainstVotes', () => {
  const verdicts: TasteVerdict[] = [tv('A', 'B', 'A'), tv('B', 'C', 'B'), tv('A', 'C', 'C')]

  it('scores agreement and excludes ties / unseen pairs from n', () => {
    const full = calibrateAgainstVotes(verdicts, [
      { aId: 'A', bId: 'B', winner: 'A' }, // agree
      { aId: 'B', bId: 'C', winner: 'B' }, // agree
      { aId: 'A', bId: 'C', winner: 'A' }, // disagree (judge said C)
      { aId: 'X', bId: 'Y', winner: 'X' }, // unseen pair → excluded
      { aId: 'A', bId: 'B', winner: 'tie' }, // human tie → excluded
    ])
    expect(full.n).toBe(3)
    expect(full.agreement).toBeCloseTo(2 / 3, 4)
  })

  it('is monotonic: full agreement → 1', () => {
    const perfect = calibrateAgainstVotes(verdicts, [
      { aId: 'A', bId: 'B', winner: 'A' },
      { aId: 'B', bId: 'C', winner: 'B' },
      { aId: 'A', bId: 'C', winner: 'C' },
    ])
    expect(perfect.agreement).toBe(1)
    expect(perfect.n).toBe(3)
  })

  it('returns 0 / 0 (never NaN) on empty input', () => {
    expect(calibrateAgainstVotes([], [])).toEqual({ agreement: 0, n: 0 })
  })
})

// ── text-judge adapter (injected model) ──────────────────────────────────────

describe('createTextJudge', () => {
  it('issues exactly one complete per comparison, parses, and echoes dimension + tokens', async () => {
    const calls: { system: string }[] = []
    const model = {
      async complete(system: string) {
        calls.push({ system })
        return { text: '{"winner":"A","confidence":0.7,"reasons":["sharp"]}', tokensUsed: 42 }
      },
    }
    const judge = createTextJudge(model)
    expect(judge.id).toBe('text-judge')

    const out = await judge.compare({
      a: subject('page'),
      b: subject('exemplar'),
      dimension: 'workflow',
    })
    expect(calls.length).toBe(1)
    expect(out).toEqual({
      winnerSlot: 'A',
      confidence: 0.7,
      reasons: ['sharp'],
      dimension: 'workflow',
      tokensUsed: 42,
    })
    // Page-vs-exemplar (no directionSummary) ⇒ the absolute-quality prompt.
    expect(calls[0].system).toContain('design critic')
  })

  it('uses the pairwise prompt when subjects carry direction summaries', async () => {
    const calls: { system: string }[] = []
    const model = {
      async complete(system: string) {
        calls.push({ system })
        return { text: '{"winner":"B","confidence":0.6,"reasons":[]}' }
      },
    }
    const judge = createTextJudge(model)
    const out = await judge.compare({
      a: subject('dir-a', { directionSummary: 'Editorial Calm' }),
      b: subject('dir-b', { directionSummary: 'Dense Control Room' }),
    })
    expect(out.winnerSlot).toBe('B')
    expect(out.dimension).toBeUndefined()
    expect(calls[0].system).toContain('art director')
  })
})
