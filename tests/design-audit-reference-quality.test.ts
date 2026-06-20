/**
 * Absolute-quality leg branch coverage — complements the happy-path block in
 * design-audit-reference-judge.test.ts by exercising the legs it does NOT:
 * page-loses-all (low win-rate), a genuine 0.5 win-rate (page split) vs the
 * ON_PAR 0.5 fallback (no decisive comparison), and the per-dimension OMISSION
 * path (a tie-only dimension is dropped, never stamped from overallWinRate).
 */
import { describe, it, expect } from 'vitest'
import { assessPageQuality } from '../src/design/audit/reference/judge/quality.js'
import type {
  Dimension,
  JudgePairInput,
  JudgeSubject,
  RawVerdict,
  TasteJudge,
} from '../src/design/audit/reference/contracts.js'

const PAGE_ID = 'page'

const subject = (id: string): JudgeSubject => ({ id, dnaSummary: `dna of ${id}` })

const v = (winnerSlot: RawVerdict['winnerSlot'], confidence = 0.9): RawVerdict => ({
  winnerSlot,
  confidence,
  reasons: [],
})

type Outcome = 'page' | 'ex' | 'tie'

/**
 * A position-invariant judge: `decide` names the winner per (exemplar, dimension)
 * and the stub returns the slot that winner occupies, so the surrounding
 * position-swap debias resolves a clean, decisive verdict (or a tie). No live
 * model — pure taste control for the win-rate math.
 */
function decisiveJudge(decide: (exId: string, dimension?: Dimension) => Outcome): TasteJudge {
  return {
    id: 'quality-stub',
    async compare(input: JudgePairInput): Promise<RawVerdict> {
      const exId = input.a.id === PAGE_ID ? input.b.id : input.a.id
      const outcome = decide(exId, input.dimension)
      if (outcome === 'tie') return v('tie', 0.2)
      const winId = outcome === 'page' ? PAGE_ID : exId
      return input.a.id === winId ? v('A') : v('B')
    },
  }
}

const page = subject(PAGE_ID)
const exemplars = [subject('ex1'), subject('ex2')]

describe('assessPageQuality — win-rate legs', () => {
  it('page loses every decisive comparison ⇒ win-rate 0 over all comparisons', async () => {
    const q = await assessPageQuality(decisiveJudge(() => 'ex'), page, exemplars)
    expect(q.overallWinRate).toBe(0)
    expect(q.comparisons).toBe(2)
    expect(q.dimensionWinRates).toBeUndefined()
  })

  it('a genuine 0.5 (one win, one loss over real comparisons) is NOT the ON_PAR fallback', async () => {
    const q = await assessPageQuality(
      decisiveJudge((exId) => (exId === 'ex1' ? 'page' : 'ex')),
      page,
      exemplars,
    )
    expect(q.overallWinRate).toBe(0.5)
    expect(q.comparisons).toBe(2) // decisive, not the comparisons=0 ON_PAR path
  })

  it('rounds the win-rate to 4 places (1 of 3 ⇒ 0.3333)', async () => {
    const q = await assessPageQuality(
      decisiveJudge((exId) => (exId === 'ex1' ? 'page' : 'ex')),
      page,
      [subject('ex1'), subject('ex2'), subject('ex3')],
    )
    expect(q.overallWinRate).toBe(0.3333)
    expect(q.comparisons).toBe(3)
  })

  it('falls back to ON_PAR 0.5 with zero comparisons when there are no exemplars', async () => {
    const q = await assessPageQuality(decisiveJudge(() => 'page'), page, [])
    expect(q.overallWinRate).toBe(0.5)
    expect(q.comparisons).toBe(0)
    expect(q.dimensionWinRates).toBeUndefined()
  })

  it('falls back to ON_PAR 0.5 when every comparison ties (no decisive signal)', async () => {
    const q = await assessPageQuality(decisiveJudge(() => 'tie'), page, exemplars)
    expect(q.overallWinRate).toBe(0.5)
    expect(q.comparisons).toBe(0)
  })
})

describe('assessPageQuality — per-dimension legs', () => {
  const dims: Dimension[] = ['product_intent', 'visual_craft', 'workflow']

  it('OMITS a dimension with no decisive comparison rather than stamping a rate', async () => {
    // visual_craft is decisive (page wins); every other dim ties ⇒ omitted.
    const judge = decisiveJudge((_exId, dim) => (dim === 'visual_craft' ? 'page' : 'tie'))
    const q = await assessPageQuality(judge, page, exemplars, { dimensions: dims })

    expect(q.dimensionWinRates).toEqual({ visual_craft: 1 })
    expect(q.dimensionWinRates?.product_intent).toBeUndefined()
    expect(q.dimensionWinRates?.workflow).toBeUndefined()
  })

  it('leaves dimensionWinRates undefined when EVERY requested dimension ties', async () => {
    // Holistic (dimension === undefined) is decisive for the page, but no
    // per-dimension comparison separates anything ⇒ the whole map is dropped,
    // proving per-dim rates are never derived from overallWinRate.
    const judge = decisiveJudge((_exId, dim) => (dim === undefined ? 'page' : 'tie'))
    const q = await assessPageQuality(judge, page, exemplars, { dimensions: dims })

    expect(q.overallWinRate).toBe(1)
    expect(q.dimensionWinRates).toBeUndefined()
  })

  it('does not run the per-dimension leg when there are no exemplars', async () => {
    const judge = decisiveJudge(() => 'page')
    const q = await assessPageQuality(judge, page, [], { dimensions: dims })
    expect(q.overallWinRate).toBe(0.5)
    expect(q.dimensionWinRates).toBeUndefined()
  })

  it('resolves a per-dimension win-rate independently of the overall leg', async () => {
    // Page wins visual_craft, loses workflow, ties product_intent (omitted).
    const judge = decisiveJudge((_exId, dim) => {
      if (dim === 'visual_craft') return 'page'
      if (dim === 'workflow') return 'ex'
      return 'tie'
    })
    const q = await assessPageQuality(judge, page, exemplars, { dimensions: dims })
    expect(q.dimensionWinRates?.visual_craft).toBe(1)
    expect(q.dimensionWinRates?.workflow).toBe(0)
    expect(q.dimensionWinRates?.product_intent).toBeUndefined()
  })
})
